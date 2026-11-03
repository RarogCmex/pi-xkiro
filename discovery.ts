/**
 * Live discovery and account-entitlement probing.
 *
 * `GET /v1/models` is public, complete, and identical for every caller — the
 * docs are explicit that it is *not* filtered by account (/api/list-models/:
 * "Presence alone does not mean your account can call the model — read
 * `access_tier`"). So on this gateway the useful dynamic half is not "which
 * ids exist" but "which tiers THIS key can run", and the answer comes from
 * `GET /v1/usage`: `plan`, `wallet.balance_usd` and `free_tokens`.
 *
 * Probed 2026-09-24 across several independent accounts, every one with
 * `plan:null` and a `0.000000` wallet → every `free` id answered 200, every
 * `paid`/`premium` id answered `403 permission_denied`. Reproducing it needs any
 * two accounts in different entitlement states, not a particular set. So the
 * default registration is free-tier
 * only, widened automatically the moment an account has a plan or a deposit,
 * and widened by hand with `XKIRO_TIERS` when someone wants the full list in
 * the picker anyway.
 *
 * The overlay `fetchModels` returns REPLACES the dynamic half (pi merges it
 * over the static baseline, per-id), so it is rebuilt from the live listing on
 * every refresh and never narrowed by a stale snapshot: a listing that fails
 * returns the previous result rather than `[]`.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { FREE_TIER_SNAPSHOT, type CatalogEntry, type XkiroTier } from "./catalog.ts";
import { entryToModel, parseListingEntry, type XkiroModel } from "./models.ts";
import { fingerprint } from "./keys.ts";

/** Raw `GET /v1/usage` payload (fields used: plan, wallet, free_tokens, user). */
export interface Entitlement {
  /** `free` for a wallet-less, plan-less account: only `access_tier:"free"` runs. */
  tiers: XkiroTier[];
  email?: string;
  plan?: string | null;
  balanceUsd?: number;
  freeRemainingToday?: number;
  freeLimitPerDay?: number;
  /** False when the probe failed; `tiers` then falls back to the safe answer. */
  probed: boolean;
}

export const FREE_ONLY: XkiroTier[] = ["free"];
export const ALL_TIERS: XkiroTier[] = ["free", "paid", "premium"];

export interface ModelsResponse {
  object?: unknown;
  data?: unknown;
}

/** `GET /v1/models` → catalog rows. Non-chat and keyless junk entries drop. */
export function parseListing(payload: unknown): CatalogEntry[] {
  const data = (payload as ModelsResponse | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const rows: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = parseListingEntry(raw as never);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    rows.push(entry);
  }
  return rows;
}

/**
 * Does this account get to call paid/premium models?
 *
 * Only a **plan** unlocks them. The docs phrase the gate as "an active paid
 * plan or real deposited balance" (/api/list-models/, /models/tiers/), which
 * reads as if any top-up would do — it does not: probed 2026-09-24 against an
 * account holding a live non-zero `wallet.balance_usd` and against the same
 * zero-balance accounts, and `openai/gpt-5.6-sol`, `openai/gpt-6-sol`,
 * `anthropic/claude-opus-5`, `z-ai/glm-5.2` and the cheapest paid id
 * (`z-ai/glm-4.6v-flashx`) answered `403 permission_denied` in both cases. So
 * a wallet balance is recorded for display but is NOT treated as an unlock.
 *
 * `plan != null` → paid and premium. That half cannot be verified from these
 * keys (none has a subscription), so it is the documented inference; the
 * escape hatch is `XKIRO_TIERS`, which registers tiers without asking.
 * Anything unknown stays locked: a model missing from the picker is fixable
 * with one env var, a 403 in the middle of a session is not.
 */
export function entitlementFromUsage(usage: unknown): Entitlement {
  const empty: Entitlement = { tiers: FREE_ONLY, probed: false };
  if (typeof usage !== "object" || usage === null) return empty;
  const body = usage as {
    plan?: unknown;
    user?: { email?: unknown };
    wallet?: { balance_usd?: unknown; held_usd?: unknown };
    free_tokens?: { remaining?: unknown; limit_per_day?: unknown };
  };
  const plan = typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : null;
  const balance = typeof body.wallet?.balance_usd === "string" ? Number.parseFloat(body.wallet.balance_usd) : undefined;

  // A non-zero wallet is deliberately NOT an unlock — see the rule above.
  const hasPlan = plan !== null;
  const tiers: XkiroTier[] = hasPlan ? ["free", "paid", "premium"] : ["free"];

  const remaining = typeof body.free_tokens?.remaining === "number" ? body.free_tokens.remaining : undefined;
  const limit = typeof body.free_tokens?.limit_per_day === "number" ? body.free_tokens.limit_per_day : undefined;
  const email = typeof body.user?.email === "string" ? body.user.email : undefined;
  return {
    tiers,
    probed: true,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(typeof balance === "number" ? { balanceUsd: balance } : {}),
    ...(remaining !== undefined ? { freeRemainingToday: remaining } : {}),
    ...(limit !== undefined ? { freeLimitPerDay: limit } : {}),
  };
}

/**
 * id → `access_tier`. pi's `Model` has no tier field, and both `filterModels`
 * and `/xkiro` need to answer "is this model open to the current account?".
 * Filled from the snapshot at import time and refreshed with every listing.
 */
const tiers = new Map<string, XkiroTier>(FREE_TIER_SNAPSHOT.map((entry) => [entry.id, entry.tier]));

/** Measured corrections to the listing's `access_tier` — see the block comment
 *  on `reportTierDenial` for why a 403 outranks the catalog. */
const TIER_ORDER: readonly XkiroTier[] = ["free", "paid", "premium"];
const learnedTiers = new Map<string, XkiroTier>();
const refusedBy = new Map<string, Set<string>>();

export function registerTiers(entries: readonly CatalogEntry[]): void {
  const counts: Record<XkiroTier, number> = { free: 0, paid: 0, premium: 0 };
  for (const entry of entries) {
    tiers.set(entry.id, entry.tier);
    counts[entry.tier] += 1;
  }
  listingCounts = counts;
}

/** undefined = this build has never seen the id. A learned refusal wins over
 *  the listing: the gateway's own 403 is a measurement, `access_tier` is a claim. */
export function tierOf(id: string): XkiroTier | undefined {
  return learnedTiers.get(id) ?? tiers.get(id);
}

/** The tier a 403 taught us, or undefined when the id was never refused. */
export function learnedTierOf(id: string): XkiroTier | undefined {
  return learnedTiers.get(id);
}

/**
 * How many ids sit in each tier **in the catalog currently in play**.
 *
 * Deliberately not `tiers.size`: that registry accumulates every listing this
 * process has ever seen (the bundled snapshot, then a mirror, then the real
 * gateway), and a mirror with one free model would otherwise be described as
 * holding the whole free tier. Counts answer "what can I pick right now", so they come
 * from the last listing parsed, falling back to the snapshot before any.
 */
let listingCounts: Record<XkiroTier, number> | undefined;

export function tierCounts(): Record<XkiroTier, number> {
  if (listingCounts) return { ...listingCounts };
  const counts: Record<XkiroTier, number> = { free: 0, paid: 0, premium: 0 };
  for (const entry of FREE_TIER_SNAPSHOT) counts[entry.tier] += 1;
  return counts;
}

/** Every known id with its tier, for `/xkiro`. `learned` marks the ids whose
 *  tier came from a real 403 rather than from the listing. */
export function knownTiers(): readonly { id: string; tier: XkiroTier; learned?: boolean }[] {
  return [...tiers.entries()].map(([id, tier]) => {
    const learned = learnedTiers.get(id);
    return learned && learned !== tier ? { id, tier: learned, learned: true } : { id, tier };
  });
}

/**
 * Learned 403s — what the gateway enforces, as opposed to what it publishes.
 *
 * `access_tier` is a claim, and it can be wrong: probed 2026-10-08,
 * `meta/muse-spark-1.2-contributor:free` is listed as `free` with a 0/0 price
 * and answers `403 permission_denied` ("available to paying customers only") to
 * a plan-less, wallet-less account. Nothing in the listing reveals that, so the
 * tier gate cannot refuse what it believes is free: the first request always
 * burns a round trip, and without a memory the picker keeps offering an id that
 * has never once worked.
 *
 * Two facts are kept, because they answer two different questions:
 *
 *   - `learnedTiers`: the corrected tier of the id. Read through `tierOf`, so
 *     every existing consumer — the pre-flight gate, `filterModels`,
 *     `gatedMessage`, `/xkiro` — sees the correction without knowing it exists.
 *   - `refusedBy`: which accounts were refused, by key fingerprint. A tier is
 *     pool-wide but a refusal is per account: in a mixed pool the plan-holding
 *     key may still be allowed, and only "every key we hold was refused" means
 *     the id is unusable here.
 *
 * The correction only ever escalates (`free` → `paid` → `premium`): the lowest
 * tier that explains a refusal from an account holding `held` is the one above
 * `held`. A plan-holding account being refused leaves nothing above it, so the
 * id keeps the top tier and `refusedBy` is what keeps it out of the picker.
 * Both maps are per-process and cleared by `/xkiro reset` — a subscription can
 * start mid-session, and a stale "no" must not outlive the fix.
 *
 * `reportTierDenial` returns the tier now believed for the id, which is what
 * the caller's refusal message quotes.
 */
export function reportTierDenial(modelId: string, key: string | undefined, now = Date.now()): XkiroTier {
  // An unmeasured account is assumed free-only, the same safe default every
  // other consumer of the entitlement cache uses.
  const held = cachedEntitlement(key, now)?.tiers ?? FREE_ONLY;
  const published = tiers.get(modelId) ?? "free";
  // Escalate from what we already believe, not from the listing: a refusal from
  // a weaker account must not undo what a stronger one taught.
  const current = learnedTiers.get(modelId) ?? published;
  const highestHeld = held.reduce((top, tier) => Math.max(top, TIER_ORDER.indexOf(tier)), 0);
  const implied = TIER_ORDER[Math.min(highestHeld + 1, TIER_ORDER.length - 1)] as XkiroTier;
  const corrected = TIER_ORDER.indexOf(implied) > TIER_ORDER.indexOf(current) ? implied : current;
  // Only a real correction is remembered as one: a `paid` id refused by a
  // free-only account confirms the listing instead of contradicting it, and
  // `/xkiro models` must not report it as a lie.
  if (corrected !== published) learnedTiers.set(modelId, corrected);
  if (key) {
    const set = refusedBy.get(modelId) ?? new Set<string>();
    set.add(fingerprint(key));
    refusedBy.set(modelId, set);
  }
  return corrected;
}

/** Was the account behind this key refused this id? */
export function isDeniedFor(modelId: string, key: string | undefined): boolean {
  if (!key) return false;
  return refusedBy.get(modelId)?.has(fingerprint(key)) ?? false;
}

/** Was every key in play refused this id? Empty pool = nothing learned. */
export function deniedForAll(modelId: string, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => isDeniedFor(modelId, key));
}

/** Learned refusals, for `/xkiro models`. Never contains a key. */
export function learnedDenials(): readonly { id: string; listed: XkiroTier; tier: XkiroTier; accounts: number }[] {
  return [...learnedTiers.entries()]
    .map(([id, tier]) => ({ id, listed: tiers.get(id) ?? "free", tier, accounts: refusedBy.get(id)?.size ?? 0 }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Over-capacity memory: "the gateway is not handing this model out right now".
//
// Deliberately separate from the learned tiers above. A 403 is a fact about the
// account-to-model relation and outlives the session; `503 service_unavailable`
// / `429 rate_limit_exceeded` is a fact about this minute. Measured 2026-11-03:
// qwen/qwen3.7-flash:free answered 200 at 15:00 and 429 by 15:40 while the
// account still had ~930k of its daily free tokens, then every qwen3.*:free id
// was over capacity. So the window expires on its own — a model that came back
// must come back here too, without the user having to know about `/xkiro reset`.
// ---------------------------------------------------------------------------

/** How long each status is believed. 503 = the model is drained right now and
 *  the gateway says "retry in a moment"; 429 on the same ids clears faster. */
export const UNAVAILABLE_TTL_MS: Readonly<Record<number, number>> = {
  429: 5 * 60_000,
  503: 15 * 60_000,
};

const unavailableUntil = new Map<string, number>();

/** Record that this id answered over capacity. Returns the moment it expires. */
export function reportModelUnavailable(modelId: string, status: number, now = Date.now()): number {
  const ttl = UNAVAILABLE_TTL_MS[status] ?? UNAVAILABLE_TTL_MS[503];
  const until = now + ttl;
  const previous = unavailableUntil.get(modelId) ?? 0;
  // A second refusal restarts the clock from the later of the two reports, so a
  // stale early write can never shorten a fresh one.
  unavailableUntil.set(modelId, Math.max(previous, until));
  return unavailableUntil.get(modelId) as number;
}

/** When the mark expires, or undefined when the id is not marked. */
export function unavailableUntilOf(modelId: string, now = Date.now()): number | undefined {
  const until = unavailableUntil.get(modelId);
  if (until === undefined) return undefined;
  if (until > now) return until;
  unavailableUntil.delete(modelId);
  return undefined;
}

/** Is this id believed to be over capacity right now? */
export function isModelUnavailableNow(modelId: string, now = Date.now()): boolean {
  return unavailableUntilOf(modelId, now) !== undefined;
}

/** Marked ids with the time they have left, for `/xkiro models`. Sorted. */
export function unavailableModels(now = Date.now()): readonly { id: string; secondsLeft: number }[] {
  const rows: { id: string; secondsLeft: number }[] = [];
  for (const id of [...unavailableUntil.keys()].sort()) {
    const until = unavailableUntilOf(id, now);
    if (until !== undefined) rows.push({ id, secondsLeft: Math.ceil((until - now) / 1000) });
  }
  return rows;
}

/** Forget every over-capacity mark (`/xkiro reset` and tests). */
export function clearUnavailable(): void {
  unavailableUntil.clear();
}

/** Forget every learned refusal (`/xkiro reset` and tests). */
export function clearLearnedDenials(): void {
  learnedTiers.clear();
  refusedBy.clear();
}

/** One probe per key, cached for the process; refreshes re-probe. */
const entitlements = new Map<string, { at: number; entitlement: Entitlement }>();
export const ENTITLEMENT_TTL_MS = 10 * 60_000;

export function cachedEntitlement(key: string | undefined, now = Date.now()): Entitlement | undefined {
  if (!key) return undefined;
  const hit = entitlements.get(fingerprint(key));
  if (!hit) return undefined;
  return now - hit.at <= ENTITLEMENT_TTL_MS ? hit.entitlement : undefined;
}

export function rememberEntitlement(key: string | undefined, entitlement: Entitlement, now = Date.now()): Entitlement {
  if (key) entitlements.set(fingerprint(key), { at: now, entitlement });
  return entitlement;
}

export function clearEntitlementCache(): void {
  entitlements.clear();
}

/**
 * `GET /v1/usage` for one key. Never throws; failure = free-only assumption.
 *
 * Cache-aware: a fresh result for this key is returned as-is, so the startup
 * prefetch, `/login`, `/xkiro` and the model refresh all share one probe per
 * key per `ENTITLEMENT_TTL_MS` instead of each paying for it.
 */
export async function probeEntitlement(
  baseUrl: string,
  key: string,
  timeoutMs = 8_000,
  fetchImpl: typeof fetch = fetch,
): Promise<Entitlement> {
  const fresh = cachedEntitlement(key);
  if (fresh) return fresh;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/usage`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return rememberEntitlement(key, { tiers: FREE_ONLY, probed: false });
    return rememberEntitlement(key, entitlementFromUsage(await response.json()));
  } catch {
    return rememberEntitlement(key, { tiers: FREE_ONLY, probed: false });
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /v1/models`, which is public — but sending the key costs nothing and
 *  keeps the request identical to what a metered catalog would need later. */
export async function fetchListing(
  baseUrl: string,
  key: string | undefined,
  timeoutMs = 8_000,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return parseListing(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Last good live overlay, so a failed refresh cannot empty the picker. Bound
 *  to the base URL it was fetched from: a mirror must not leak models into the
 *  public gateway's list. */
let lastOverlay: { baseUrl: string; models: XkiroModel[] } | undefined;

export function lastGoodOverlay(baseUrl?: string): readonly XkiroModel[] {
  if (!lastOverlay) return [];
  if (baseUrl && lastOverlay.baseUrl !== baseUrl) return [];
  return lastOverlay.models;
}

/** Test hook: pretend no refresh has ever succeeded. */
export function clearLastGoodListing(): void {
  lastOverlay = undefined;
}

export interface FetchModelsArgs {
  baseUrl: string;
  context: RefreshModelsContext;
  /** `auto` → derive from the entitlement probe; explicit list → honour it. */
  tiers: XkiroTier[] | "auto";
  resolveKey: (context: RefreshModelsContext) => string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Tier filter actually applied on the last successful pass, so `filterModels`
 *  and the persisted overlay agree. */
let appliedTiers: XkiroTier[] = FREE_ONLY;

export function appliedTierFilter(): readonly XkiroTier[] {
  return appliedTiers;
}

/**
 * `fetchModels` implementation. Never throws: on any failure pi keeps the
 * snapshot baseline plus the previous overlay.
 */
export async function fetchXkiroModels({
  baseUrl,
  context,
  tiers,
  resolveKey,
  timeoutMs = 8_000,
  fetchImpl = fetch,
}: FetchModelsArgs): Promise<XkiroModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return lastOverlay?.models ?? [];

  const key = resolveKey(context);
  const listing = await fetchListing(baseUrl, key, timeoutMs, fetchImpl);
  if (context.signal.aborted || listing.length === 0) return lastOverlay?.models ?? [];

  const entitlement =
    tiers === "auto"
      ? key
        ? await probeEntitlement(baseUrl, key, timeoutMs, fetchImpl)
        : { tiers: FREE_ONLY, probed: false }
      : { tiers, probed: true };
  const allowed = new Set<XkiroTier>(entitlement.tiers);
  appliedTiers = [...allowed];

  lastOverlay = {
    baseUrl,
    models: listing.filter((entry) => allowed.has(entry.tier)).map((entry) => entryToModel(entry, baseUrl)),
  };
  return lastOverlay.models;
}

/**
 * Measure every account in play, once, before pi selects a model.
 *
 * The transport's tier gate and `filterModels` both ask "can this account run
 * paid models?", and an unmeasured account must not be refused — so the answer
 * has to exist by the time the first request goes out. One `GET /v1/usage` per
 * key, in parallel, bounded; failures simply stay unmeasured.
 */
export async function prefetchEntitlements(
  baseUrl: string,
  keys: readonly string[],
  timeoutMs = 4_000,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Entitlement>> {
  const out = new Map<string, Entitlement>();
  await Promise.all(
    keys.map(async (key) => {
      out.set(key, await probeEntitlement(baseUrl, key, timeoutMs, fetchImpl));
    }),
  );
  return out;
}

/**
 * Catalog rows available at extension-load time.
 *
 * pi does not run a model refresh on every startup path — `pi --list-models`
 * and print mode resolve the model against whatever the provider registered
 * synchronously — so a widened `XKIRO_TIERS` would otherwise only appear after
 * some later refresh. pi's documented answer is an async extension factory:
 * "Pi waits for asynchronous factories before startup continues, so providers
 * registered there are available to startup model selection and
 * `pi --list-models`" (pi's own custom-provider documentation). This function is what that
 * factory awaits: one public listing call (plus one quota probe when tiers are
 * automatic), bounded by `timeoutMs`, and `undefined` on any failure so the
 * caller falls back to the bundled snapshot rather than blocking startup.
 */
export async function startupCatalog(
  baseUrl: string,
  key: string | undefined,
  tiers: XkiroTier[] | "auto",
  timeoutMs = 4_000,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogEntry[] | undefined> {
  const listing = await fetchListing(baseUrl, key, timeoutMs, fetchImpl);
  if (listing.length === 0) return undefined;
  registerTiers(listing);
  if (tiers === "auto") {
    if (!key) return listing.filter((entry) => entry.tier === "free");
    const entitlement = await probeEntitlement(baseUrl, key, timeoutMs, fetchImpl);
    const allowed = new Set(entitlement.tiers);
    return listing.filter((entry) => allowed.has(entry.tier));
  }
  const allowed = new Set(tiers);
  return listing.filter((entry) => allowed.has(entry.tier));
}

/** Every tier present in the snapshot; used when no probe has run yet. */
export const SNAPSHOT_TIERS: readonly XkiroTier[] = [...new Set(FREE_TIER_SNAPSHOT.map((entry) => entry.tier))];
