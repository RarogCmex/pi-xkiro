/**
 * Key pool for xKiro.
 *
 * Why a pool at all: xKiro meters its free tier **per account**, not per key.
 * `GET /v1/usage` (probed 2026-09-24) returns `free_tokens.{used_today,
 * limit_per_day, remaining}` and a `user.email`, and the five keys in
 * `secret.env` resolve to five DIFFERENT accounts — one with a 500 000
 * token/day allowance, four with 1 000 000 each, each with an independent
 * `used_today` counter. One key therefore burns 1/5 of the available free
 * throughput; a pool that keeps a pi session on one account and spreads
 * different sessions across accounts multiplies it.
 *
 * Sticky-per-session, not round-robin-per-request: the gateway routes to
 * upstreams that keep a prompt cache (`usage.prompt_tokens_details.cached_tokens`
 * is non-zero on repeated turns, probed), and cache hits need the same
 * upstream route. Switching keys mid-conversation would restart that cache, so
 * a session keeps its account until that account says it is out of capacity.
 *
 * Sources, in precedence order, all optional:
 *   XKIRO_API_KEYS       comma-separated list ("first,second")
 *   XKIRO_API_KEYS_FILE  JSON array of strings, hot-reloaded on mtime change
 *   credential / XKIRO_API_KEY  the single key pi resolved (/login or env)
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export const KEYS_ENV_VAR = "XKIRO_API_KEYS";
/** The single-key variable, matching `API_KEY_ENV_VAR` in models.ts. */
export const SINGLE_KEY_ENV_VAR = "XKIRO_API_KEY";
export const KEYS_FILE_ENV_VAR = "XKIRO_API_KEYS_FILE";
export const ROTATION_ENV_VAR = "XKIRO_KEY_ROTATION";

export const DEFAULT_KEYS_FILE_NAME = "~/.pi/agent/xkiro-keys.json";

/** Sources whose entries survive a `refresh()` that does not list them. */
const POOL_MANAGED_SOURCES = new Set(["credential", "request"]);

/** Cooldown lengths. A daily quota only resets at the day boundary; a 429 is
 *  a moment of congestion; a 401 key is not coming back without user action,
 *  so it is parked for a long time instead of being retried every turn. */
export const COOLDOWN_QUOTA_MS = 5 * 60_000;
export const COOLDOWN_RATE_MS = 60_000;
export const COOLDOWN_AUTH_MS = 6 * 60 * 60_000;

export type FailureKind = "quota" | "rate" | "auth" | "transient";

export interface KeyPoolOptions {
  env: Record<string, string | undefined>;
  now?: () => number;
  /** One warning per event (bad JSON, unreadable file, …). */
  onWarn?: (message: string) => void;
}

export interface KeyStatus {
  /** Never the key itself: fingerprint + tail, safe to print. */
  label: string;
  source: string;
  coolingMs: number;
  failures: number;
}

/** Comma-separated inline list; empty elements dropped. */
export function parseInlineKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `["k1","k2"]` or `{"keys":[…]}`; anything else is a malformed file. */
export function parseKeysFileContent(raw: string): { keys?: string[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as { keys?: unknown }).keys
      : undefined;
  if (!Array.isArray(list)) return { error: "expected a JSON array of key strings, or {\"keys\":[…]}" };
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return { error: "keys must all be strings" };
    const trimmed = entry.trim();
    if (!trimmed) return { error: "keys contains an empty string" };
    out.push(trimmed);
  }
  return { keys: out };
}

/** Stable non-secret handle for a key: short hash + last 4 characters. */
export function fingerprint(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  const hex = (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return `${hex}…${key.slice(-4)}`;
}

/** Gate paid/premium models on accounts that cannot run them (default: on). */
export const BLOCK_GATED_ENV_VAR = "XKIRO_BLOCK_GATED";

export function gatingEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[BLOCK_GATED_ENV_VAR]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/** `off`/`0`/`false` disables rotation; anything else (including unset) keeps it on. */
export function rotationEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[ROTATION_ENV_VAR]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

interface Entry {
  key: string;
  source: string;
  coolingUntil: number;
  failures: number;
}

export class XkiroKeyPool {
  private readonly opts: KeyPoolOptions;
  private file: { path: string; mtimeMs: number; keys: string[] } | undefined;
  private entries = new Map<string, Entry>();
  /** sessionId → key. Cleared entries re-pick on the next request. */
  private sticky = new Map<string, string>();
  private cursor = 0;
  private priority: string[] | undefined;
  private warned = new Set<string>();

  constructor(opts: KeyPoolOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private warnOnce(id: string, message: string): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    this.opts.onWarn?.(message);
  }

  /**
   * Reorder the pool by measured preference (see `balancePool` in provider.ts).
   *
   * pi runs one conversation per process, and the pool is per-process state,
   * so "spread sessions across accounts" cannot be done by rotating a cursor:
   * every freshly started pi would take the first key again — measured on
   * 2026-09-24, four concurrent `pi -p` runs put 39,924 tokens on one account
   * and left the other untouched. What does work across processes is choosing
   * by what the account has LEFT today, which `GET /v1/usage` reports.
   */
  setPriority(order: readonly string[]): void {
    this.priority = [...order];
  }

  /** Keys that came from an explicit env source, in configured order. Used for
   *  the "is this provider configured at all" answer, which must not be yes
   *  just because an earlier resolve cached a credential. */
  envKeys(): string[] {
    return this.refresh().filter((key) => {
      const source = this.entries.get(key)?.source;
      return source === KEYS_ENV_VAR || source === KEYS_FILE_ENV_VAR || source === SINGLE_KEY_ENV_VAR;
    });
  }

  /** Add a key discovered outside the env sources (pi's stored credential). */
  addCredentialKey(key: string | undefined, source = "credential"): void {
    const trimmed = key?.trim();
    if (!trimmed) return;
    if (!this.entries.has(trimmed)) this.entries.set(trimmed, this.newEntry(trimmed, source));
  }

  private newEntry(key: string, source: string): Entry {
    return { key, source, coolingUntil: 0, failures: 0 };
  }

  /** Read the file source, re-reading only when mtime moved. */
  private fromFile(): string[] {
    const rawPath = this.opts.env[KEYS_FILE_ENV_VAR]?.trim() || undefined;
    if (!rawPath) return [];
    const path = rawPath.startsWith("~") ? rawPath.replace(/^~/, process.env.HOME ?? "~") : rawPath;
    if (!existsSync(path)) {
      this.warnOnce(`missing:${path}`, `xkiro: ${KEYS_FILE_ENV_VAR} points at ${path}, which does not exist.`);
      return [];
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return this.file?.path === path ? this.file.keys : [];
    }
    if (this.file && this.file.path === path && this.file.mtimeMs === mtimeMs) return this.file.keys;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      this.warnOnce(
        `unreadable:${path}`,
        `xkiro: cannot read ${path} (${error instanceof Error ? error.message : String(error)}); keeping the previous pool.`,
      );
      return this.file?.path === path ? this.file.keys : [];
    }
    const parsed = parseKeysFileContent(text);
    if (!parsed.keys) {
      this.warnOnce(`parse:${path}`, `xkiro: ${path} is not a usable key file (${parsed.error}); keeping the previous pool.`);
      return this.file?.path === path ? this.file.keys : [];
    }
    this.file = { path, mtimeMs, keys: parsed.keys };
    return parsed.keys;
  }

  /** Every candidate, deduplicated, env list first (it is the explicit one). */
  refresh(): string[] {
    const found: { key: string; source: string }[] = [];
    for (const key of parseInlineKeys(this.opts.env[KEYS_ENV_VAR])) found.push({ key, source: KEYS_ENV_VAR });
    for (const key of this.fromFile()) found.push({ key, source: KEYS_FILE_ENV_VAR });
    const single = this.opts.env[SINGLE_KEY_ENV_VAR]?.trim();
    if (single) found.push({ key: single, source: SINGLE_KEY_ENV_VAR });

    const seen = new Set<string>();
    const merged: string[] = [];
    for (const { key, source } of found) {
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(key);
      // A key discovered from env keeps its original source label; re-exporting
      // it from the env must not relabel a credential the transport already
      // parked.
      const existing = this.entries.get(key);
      this.entries.set(key, existing ?? this.newEntry(key, source));
    }
    // Keys pi handed us (auth.json credential, `--api-key`, an apiKey from
    // models.json) are not in any env source: they stay in the pool behind the
    // explicit env list, so `XKIRO_API_KEYS` always wins on ordering.
    for (const [key, entry] of this.entries) {
      if (seen.has(key) || !POOL_MANAGED_SOURCES.has(entry.source)) continue;
      seen.add(key);
      merged.push(key);
    }
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key)!;
      if (!seen.has(key) && !POOL_MANAGED_SOURCES.has(entry.source)) this.entries.delete(key);
    }
    if (this.priority?.length) {
      const rank = new Map(this.priority.map((key, index) => [key, index] as const));
      // Stable sort by measured preference; keys the balancer never saw keep
      // their configured position at the end.
      merged.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
    }
    return merged;
  }

  /** Every candidate key, ignoring cooldown. For `/xkiro` only — the transport
   *  must go through `pick()`/`available()`. */
  all(): string[] {
    return this.refresh();
  }

  /** Keys currently eligible (not in cooldown). Falls back to the full list
   *  when everything is cooling — a stale cooldown must not lock pi out. */
  available(): string[] {
    const all = this.refresh();
    return this.readyFrom(all);
  }

  /** Eligible keys, or every candidate when all of them are parked. Exported
   *  separately so `/xkiro` can tell "waiting" from "cooling". */
  readyFrom(all: readonly string[], now = this.now()): string[] {
    const ready = all.filter((key) => (this.entries.get(key)?.coolingUntil ?? 0) <= now);
    return ready.length > 0 ? ready : all.length ? [...all] : [];
  }

  /** The key for one request: the session's sticky key when it is still
   *  eligible, otherwise the next eligible one (rotating cursor).
   *  `exclude` skips keys this logical request already burned; `only` restricts
   *  the choice to keys that can actually serve the requested model (see
   *  `selectKeysForTier` in provider.ts). An `only` list that nothing survives
   *  falls back to the unrestricted choice, because an entitlement we have not
   *  measured is not a denial. */
  pick(sessionId?: string, exclude: readonly string[] = [], only?: readonly string[]): string | undefined {
    let ready = this.available().filter((key) => !exclude.includes(key));
    if (only?.length) {
      const narrowed = ready.filter((key) => only.includes(key));
      if (narrowed.length > 0) ready = narrowed;
    }
    if (ready.length === 0) return undefined;
    const rotation = rotationEnabled(this.opts.env);
    if (sessionId && rotation) {
      const sticky = this.sticky.get(sessionId);
      if (sticky && ready.includes(sticky)) return sticky;
    }
    const chosen = rotation ? ready[this.cursor % ready.length] : ready[0];
    this.cursor = (this.cursor + 1) % Math.max(ready.length, 1);
    if (sessionId) this.sticky.set(sessionId, chosen);
    return chosen;
  }

  /** Which key a session is pinned to (for `/xkiro`). */
  pinned(sessionId: string | undefined): string | undefined {
    return sessionId ? this.sticky.get(sessionId) : undefined;
  }

  /** Record a failure and park the key for the duration the cause implies. */
  reportFailure(key: string | undefined, kind: FailureKind): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.failures += 1;
    const ms =
      kind === "quota"
        ? COOLDOWN_QUOTA_MS
        : kind === "rate"
          ? COOLDOWN_RATE_MS
          : kind === "auth"
            ? COOLDOWN_AUTH_MS
            : 5_000;
    entry.coolingUntil = Math.max(entry.coolingUntil, this.now() + ms);
    // Any session pinned to a dead key must re-pick on its next request.
    for (const [session, pinned] of this.sticky) if (pinned === key) this.sticky.delete(session);
  }

  /** A success clears the parking and the failure counter. */
  reportSuccess(key: string | undefined): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.coolingUntil = 0;
    entry.failures = 0;
  }

  /** Printable state; never contains a key. */
  status(): KeyStatus[] {
    const now = this.now();
    return this.refresh().map((key) => {
      const entry = this.entries.get(key)!;
      return {
        label: fingerprint(key),
        source: entry.source,
        coolingMs: Math.max(0, entry.coolingUntil - now),
        failures: entry.failures,
      };
    });
  }

  /** Drop sticky assignments and cooldowns (used by `/xkiro reset` and tests). */
  reset(): void {
    this.sticky.clear();
    this.cursor = 0;
    for (const entry of this.entries.values()) {
      entry.coolingUntil = 0;
      entry.failures = 0;
    }
  }
}

/**
 * Classify an HTTP status into a cooldown cause. xKiro's status table (docs
 * /api/errors/): 402 insufficient_quota, 429 rate_limit_exceeded, 401
 * authentication_error, 500/502/503/529 server-side. `body` is the raw error
 * text, which is the only place a *daily free-token* exhaustion is
 * distinguishable from plain congestion.
 */
export function failureKindForStatus(status: number | undefined, body?: string): FailureKind | undefined {
  if (status === undefined) return undefined;
  if (status === 402) return "quota";
  if (status === 429) return /daily|quota|free_tokens|limit_per_day/i.test(body ?? "") ? "quota" : "rate";
  if (status === 401) return "auth";
  if (status >= 500) return "transient";
  return undefined;
}

/**
 * Same classification, but from the composed `errorMessage` pi hands back —
 * the HTTP status is not carried on the message object, only in its text
 * ("<msg>" or "<status>: <body>", see pi-ai utils/error-body.js).
 */
export function failureKindForMessage(message: string): FailureKind | undefined {
  if (!message) return undefined;
  if (/insufficient_quota|insufficient balance|daily|limit_per_day|free_tokens/i.test(message)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return "rate";
  if (/authentication_error|invalid or disabled clientapikey|\b401\b/i.test(message)) return "auth";
  if (/\b50[023]\b|server error|bad gateway|service unavailable|overloaded/i.test(message)) return "transient";
  return undefined;
}
