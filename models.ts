/**
 * Catalog → pi `Model`, plus the gateway facts that are not per-model.
 *
 * Two things any gateway plugin has to decide, and this one decides both:
 *
 *  1. **Wire surface.** xKiro serves three (`/chat/completions`,
 *     `/v1/messages`, `/v1/responses`) and all three were probed working with
 *     a free-tier model on 2026-09-24. Only `openai-completions` is registered
 *     here: it is the documented default path, it covers every model in the
 *     catalog, and pi's adapter for it already parses the `reasoning_content`
 *     delta this gateway emits for chain-of-thought. Mixing surfaces would buy
 *     nothing and double the number of request shapes to keep verified.
 *
 *  2. **Compat flags.** `api.xkiro.com` matches none of pi's URL
 *     auto-detection rules (`detectCompat` in pi-ai's openai-completions
 *     adapter), so the flags are stated explicitly below, each one from a
 *     probe rather than from the gateway's "OpenAI-compatible" claim. The
 *     gateway is unusually tolerant — it accepts and silently ignores unknown
 *     request fields (`totally_unknown_field: 123` → 200) — so "accepted" is
 *     not evidence of "honoured", and fields that could not be shown to have
 *     an effect are left off rather than on.
 */

import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
  isTier,
  SNAPSHOT_BY_ID,
  thinkingLevelMap,
  UNKNOWN_DEFAULTS,
  type CatalogEntry,
  type XkiroApi,
  type XkiroModelEntry,
  type XkiroReasoningEfforts,
  type XkiroTier,
} from "./catalog.ts";

export type { XkiroApi } from "./catalog.ts";

export const PROVIDER_ID = "xkiro";
export const PROVIDER_NAME = "xKiro";
/** Docs, /guides/sdk-openai/: the OpenAI SDKs append `/chat/completions`, so
 *  the base URL must carry the `/v1`. Dropping it is the 404 everyone hits. */
export const DEFAULT_BASE_URL = "https://api.xkiro.com/v1";

export const API_KEY_ENV_VAR = "XKIRO_API_KEY";
export const BASE_URL_ENV_VAR = "XKIRO_BASE_URL";
/** Comma list of `access_tier`s to register, overriding entitlement
 *  detection: `free`, `free,paid`, `free,paid,premium`, or `auto` (default). */
export const TIERS_ENV_VAR = "XKIRO_TIERS";
/** Set to `off`/`0`/`false` to pin every request to the primary key. */
export const ROTATION_ENV_VAR = "XKIRO_KEY_ROTATION";

/** USD per 1M tokens — no currency conversion on this gateway, unlike the
 *  CNY ones (`pricing.unit` is `per_1m_tokens`, verified on the whole
 *  catalog). */
const PRICE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Verified request-shape facts about this gateway (README "Проверено"). */
export const CHAT_COMPAT: OpenAICompletionsCompat = {
  // Both spellings are accepted by every probed model and the cap is honoured
  // (`completion_tokens` == the cap, `finish_reason:"length"`); pin pi's
  // OpenAI-standard choice so a future detection change cannot alter it.
  maxTokensField: "max_completion_tokens",
  // `role:"developer"` → 200 (probed). The gateway normalizes roles itself.
  supportsDeveloperRole: true,
  // `store:true` → 200 but nothing is stored that we can observe; do not send.
  supportsStore: false,
  // `stream_options:{include_usage:true}` produces the trailing usage-only
  // frame pi needs for cost accounting (probed).
  supportsUsageInStreaming: true,
  // `stop` / `length` / `tool_calls` all observed live (probed).
  supportsFinishReason: true,
  // `reasoning_effort` is honoured per model; models without a control ignore
  // it, and this gateway never rejects an unknown level (probed 200 for
  // `zzz-nope`), which is why the level set is mapped per model rather than
  // trusted blindly (docs /guides/reasoning/).
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
  // Tool results work with and without `name` (probed both → 200, same answer).
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  // Thinking arrives as `reasoning_content`, which pi parses natively; it does
  // not need to be smuggled through text, and replaying it is accepted (probed).
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  // `strict:true` is accepted but enforcement is not documented and cannot be
  // probed from here; do not claim it. Same for grammar tools.
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  // Mid-conversation system messages are not documented for this gateway, and
  // the transcript here is multi-vendor. Fold them instead.
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false,
  // `prompt_cache_retention:"24h"` is accepted (probed 200); no published TTL
  // semantics, so cache warming is left to pi's defaults.
  supportsLongCacheRetention: false,
};

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Mirror/proxy override. Trailing slashes stripped: the adapter appends
 *  `/chat/completions` to whatever it is given. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

/** Which `access_tier`s to put in the picker. `auto` (default) means "free
 *  only unless the account probe says otherwise"; an explicit list wins. */
export function resolveTiers(env: EnvReader = processEnv): XkiroTier[] | "auto" {
  const raw = env(TIERS_ENV_VAR)?.trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  const tiers = raw
    .split(",")
    .map((tier) => tier.trim())
    .filter(isTier);
  return tiers.length > 0 ? [...new Set(tiers)] : "auto";
}

/**
 * Raw listing entry → normalized catalog row. Returns undefined for anything
 * that is not a chat model with a usable id: `GET /v1/models` answers `chat`
 * only unless asked otherwise (docs /api/list-models/), but a `?modality=all`
 * capture or a future default change must not smuggle a TTS voice into the
 * model picker.
 */
export function parseListingEntry(raw: XkiroModelEntry): CatalogEntry | undefined {
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
  if (raw.modality !== undefined && raw.modality !== "chat") return undefined;
  const id = raw.id.trim();
  const capabilities = raw.capabilities ?? {};
  const tier: XkiroTier = isTier(raw.access_tier) ? raw.access_tier : "free";
  const effort = normalizeEfforts(raw.reasoning_efforts);
  const slash = id.lastIndexOf("/");
  const price: CatalogEntry["price"] = {
    input: number(raw.pricing?.input),
    output: number(raw.pricing?.output),
  };
  for (const field of PRICE_FIELDS) {
    if (field === "input" || field === "output") continue;
    const value = raw.pricing?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      price[field === "cache_read" ? "cacheRead" : "cacheWrite"] = value;
    }
  }
  return {
    id,
    name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : slash >= 0 ? id.slice(slash + 1) : id,
    vendor: typeof raw.owned_by === "string" ? raw.owned_by : slash >= 0 ? id.slice(0, slash) : "",
    tier,
    contextWindow: number(raw.context_length, UNKNOWN_DEFAULTS.contextWindow) || UNKNOWN_DEFAULTS.contextWindow,
    maxTokens: number(raw.max_output_tokens, UNKNOWN_DEFAULTS.maxTokens) || UNKNOWN_DEFAULTS.maxTokens,
    input: capabilities.vision === true ? ["text", "image"] : ["text"],
    tools: capabilities.tools !== false,
    reasoning: capabilities.reasoning === true,
    effort,
    price,
  };
}

function normalizeEfforts(raw: unknown): XkiroReasoningEfforts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const levels = (raw as { levels?: unknown }).levels;
  if (!Array.isArray(levels)) return null;
  const clean = levels.filter((level): level is string => typeof level === "string" && level.trim() !== "");
  if (clean.length === 0) return null;
  const def = (raw as { default?: unknown }).default;
  return typeof def === "string" && def.trim() ? { levels: clean, default: def.trim() } : { levels: clean };
}

export type XkiroModel = Model<XkiroApi>;

/** Catalog row → pi `Model`. The tier is not a pi concept, so it is carried in
 *  the display name for gated models (`… [premium]`): the picker explains
 *  itself without inventing a pi field, and `filterModels` stays the place
 *  that decides availability. `entry.tools` has no pi equivalent — every id in
 *  this catalog advertises it and the whole free tier was verified to answer
 *  a tool call — so it is carried for status output only. */
export function entryToModel(entry: CatalogEntry, baseUrl: string): XkiroModel {
  const model: XkiroModel = {
    id: entry.id,
    name: entry.tier === "free" ? entry.name : `${entry.name} [${entry.tier}]`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: entry.reasoning,
    input: entry.input,
    cost: {
      input: entry.price.input,
      output: entry.price.output,
      cacheRead: entry.price.cacheRead ?? 0,
      cacheWrite: entry.price.cacheWrite ?? 0,
    },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...CHAT_COMPAT },
  };
  const map = thinkingLevelMap(entry.effort);
  if (entry.effort && map) {
    model.thinkingLevelMap = map;
  } else if (entry.reasoning) {
    // Reasons, but exposes no control (the majority of the catalog): pi must
    // not offer /thinking levels it cannot honour. `{ off: null }` is how pi
    // expresses "always on, nothing to switch".
    model.thinkingLevelMap = { off: null };
  }
  return model;
}

/** Offline baseline: the bundled free-tier snapshot, filtered to what the
 *  user asked to register. */
export function snapshotModels(tiers: readonly XkiroTier[], baseUrl: string): XkiroModel[] {
  const allowed = new Set(tiers);
  return [...SNAPSHOT_BY_ID.values()].filter((entry) => allowed.has(entry.tier)).map((entry) => entryToModel(entry, baseUrl));
}
