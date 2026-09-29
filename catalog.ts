/**
 * xKiro catalog model: the shape of `GET /v1/models` and the snapshot this
 * build ships with.
 *
 * Data provenance — everything here traces to a live capture on 2026-09-24
 * against `https://api.xkiro.com/v1` (see `live/check.ts` to re-capture):
 *
 *   `GET /v1/models` is PUBLIC (no key) and returns the full chat listing with
 *   metadata per id (120 ids in the morning capture, 125 by that evening — the
 *   gateway adds ids during the day, so no count here is authoritative):
 *   `display_name`, `owned_by`,
 *   `access_tier` (free | paid | premium), `context_length`,
 *   `max_output_tokens`, `capabilities{vision,tools,reasoning}`, `pricing`
 *   (USD per 1M tokens: input/output/cache_read/cache_write) and, where the
 *   model exposes a control, `reasoning_efforts{levels,default}`.
 *
 *   This gateway is NOT per-key in what it LISTs (docs, /api/list-models/:
 *   "it is not filtered by account"). What a
 *   key can CALL is decided by `access_tier` × account entitlement: `free`
 *   works on a zero-balance account, `paid`/`premium` answer
 *   `403 permission_denied` unless the account has a real deposit or a plan
 *   (probed 2026-09-24 across several *independent* accounts, which is what
 *   makes it a property of the gateway rather than of one subscription: every
 *   account got 403 on `openai/gpt-5.6-sol`, `openai/gpt-6-sol` and
 *   `z-ai/glm-5.2`, and 200 on every `access_tier:"free"` id).
 *
 * So the catalog is fully dynamic in principle and the snapshot below is only
 * the offline baseline: the free tier, which is what an account with no
 * deposit can actually run. `fetchModels` (discovery.ts) layers the live
 * listing on top and widens it when the account is entitled to more.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** pi model ids on this gateway keep the vendor prefix (`vendor/model`), which
 *  xKiro requires: a bare `gpt-5.6-sol` is a `404 not_found`. */
export type XkiroTier = "free" | "paid" | "premium";

/** The one surface this plugin drives. xKiro also serves `/v1/messages`
 *  (Anthropic shape) and `/v1/responses`; both were probed working for
 *  non-Claude models too, but Chat Completions is the documented
 *  "better-trodden path" and covers every model, so nothing here needs the
 *  other two. */
export type XkiroApi = "openai-completions";

/** `reasoning_efforts` as published. Absent means the model has no reasoning
 *  control at all — a majority of the listing (51 of the 120 ids in the
 *  2026-09-24 morning capture) — and sending `reasoning_effort` to those changes
 *  nothing and costs nothing (docs /guides/reasoning/). */
export interface XkiroReasoningEfforts {
  levels: string[];
  default?: string;
}

export interface XkiroPricing {
  currency?: string;
  unit?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

/** Raw `GET /v1/models` entry. Every field is optional except `id`: the docs
 *  promise the metadata set is additive, so unknown fields are ignored and
 *  missing ones fall back (see `entryToModel`). */
export interface XkiroModelEntry {
  id?: unknown;
  object?: unknown;
  type?: unknown;
  display_name?: unknown;
  created?: unknown;
  owned_by?: unknown;
  modality?: unknown;
  access_tier?: unknown;
  context_length?: unknown;
  max_output_tokens?: unknown;
  capabilities?: { vision?: unknown; tools?: unknown; reasoning?: unknown };
  pricing?: XkiroPricing;
  reasoning_efforts?: XkiroReasoningEfforts;
}

/** Normalized catalog row — the unit both the snapshot and the live listing
 *  are expressed in. */
export interface CatalogEntry {
  id: string;
  name: string;
  vendor: string;
  tier: XkiroTier;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  /** Whether the model accepts tool definitions. Verified for the whole free
   *  tier on 2026-09-24 (37/37 returned `finish_reason:"tool_calls"`). */
  tools: boolean;
  reasoning: boolean;
  /** Published `reasoning_efforts`, when the model has a control. */
  effort: XkiroReasoningEfforts | null;
  /** USD per 1M tokens, as published. */
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** `context_length`/`max_output_tokens` are documented as "omitted when the
 *  catalog has not verified a number — absent means unknown, not unlimited",
 *  so unknowns get a conservative floor rather than a big optimistic one. */
export const UNKNOWN_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

export const TIERS: readonly XkiroTier[] = ["free", "paid", "premium"];

export function isTier(value: unknown): value is XkiroTier {
  return value === "free" || value === "paid" || value === "premium";
}

/**
 * Levels pi can ask for, in ascending order, with their published rank on
 * xKiro's side. xKiro's vocabulary is wider than pi's (`none`, `off`,
 * `disabled`, `adaptive`, `on`) and per model; rank is what lets a request for
 * a level a model does not have land on a real one instead of being dropped
 * server-side (unrecognised values are "never forwarded upstream" per docs, so
 * a dropped value silently means "model default", which is not what the user
 * asked for).
 */
const LEVEL_RANK: Record<string, number> = {
  none: -3,
  disabled: -3,
  off: -3,
  minimal: -1,
  low: 0,
  medium: 1,
  high: 2,
  adaptive: 2,
  on: 2,
  xhigh: 3,
  max: 4,
};

/** Levels that mean "reasoning off" in xKiro's vocabulary, in preference order. */
const OFF_VALUES = ["none", "disabled", "off"] as const;

/** pi's own level names, ascending. */
export const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function rank(level: string): number {
  return LEVEL_RANK[level] ?? 2;
}

/**
 * Translate a published `reasoning_efforts.levels` set into pi's
 * `ThinkingLevelMap`.
 *
 * Rules (docs /guides/reasoning/, "Levels a model does not have"):
 *  - `off`  → the model's own off value, or `null` when it has none (then pi
 *    will not offer "off" for the model at all).
 *  - exact hit → that level.
 *  - otherwise the highest published positive level at or below the request.
 *  - if nothing is at or below, the lowest positive level: on a two-position
 *    model ("any positive level turns the switch on") asking for less is still
 *    asking for thinking, and the alternative — letting the server drop the
 *    value — silently falls back to that model's default, which is `off` for
 *    e.g. `mistralai/mistral-small-2603` (`levels: ["none","high"]`).
 */
export function thinkingLevelMap(effort: XkiroReasoningEfforts | null | undefined): ThinkingLevelMap | undefined {
  if (!effort || !Array.isArray(effort.levels) || effort.levels.length === 0) return undefined;
  const levels = effort.levels.filter((l): l is string => typeof l === "string");
  const positive = levels.filter((l) => !OFF_VALUES.includes(l as (typeof OFF_VALUES)[number]));
  const map: ThinkingLevelMap = {};

  const off = OFF_VALUES.find((l) => levels.includes(l));
  map.off = off ?? null;

  for (const level of PI_LEVELS) {
    if (levels.includes(level)) {
      map[level] = level;
      continue;
    }
    if (positive.length === 0) {
      map[level] = null;
      continue;
    }
    const wanted = rank(level);
    const below = positive.filter((l) => rank(l) <= wanted);
    const chosen = below.length
      ? below.reduce((a, b) => (rank(a) >= rank(b) ? a : b))
      : positive.reduce((a, b) => (rank(a) <= rank(b) ? a : b));
    map[level] = chosen;
  }
  return map;
}

/**
 * Free-tier snapshot, captured 2026-09-24 from `GET /v1/models` (42 chat ids).
 * The 37 ids captured earlier the same day were each confirmed callable on every
 * key in the pool, tool-calling included; the five added by the evening capture
 * carry the listing's metadata but were not individually probed.
 * Regenerate with `node live/check.ts --snapshot`.
 *
 * Paid and premium ids are intentionally NOT baked in: they are unreachable
 * without a deposit, and the live listing adds them the moment the account is
 * entitled.
 */
export const FREE_TIER_SNAPSHOT: readonly CatalogEntry[] = [
  { id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek V3.1", vendor: "deepseek", tier: "free",
    contextWindow: 163_840, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", vendor: "deepseek", tier: "free",
    contextWindow: 131_072, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", vendor: "deepseek", tier: "free",
    contextWindow: 1_048_576, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", vendor: "deepseek", tier: "free",
    contextWindow: 1_048_576, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "deepseek/deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)", vendor: "deepseek", tier: "free",
    contextWindow: 1_048_576, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2:free", name: "MiniMax M2 (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.1-highspeed:free", name: "MiniMax M2.1 Highspeed (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.1:free", name: "MiniMax M2.1 (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.5-highspeed:free", name: "MiniMax M2.5 Highspeed (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.7-highspeed:free", name: "MiniMax M2.7 Highspeed (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m2.7:free", name: "MiniMax M2.7 (Free)", vendor: "minimax", tier: "free",
    contextWindow: 204_800, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "minimax/minimax-m3:free", name: "MiniMax M3 (Free)", vendor: "minimax", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: { levels: ["adaptive", "disabled"], default: "disabled" }, price: { input: 0, output: 0 } },
  { id: "mistralai/codestral-2508", name: "Codestral", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 16_384, input: ["text"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/devstral-medium", name: "Devstral 2", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 16_384, input: ["text"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/ministral-14b", name: "Ministral 3 14B", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 8_192, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/ministral-3b", name: "Ministral 3 3B", vendor: "mistral", tier: "free",
    contextWindow: 128_000, maxTokens: 8_192, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/ministral-8b", name: "Ministral 3 8B", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 8_192, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/mistral-large-2512", name: "Mistral Large 3", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 16_384, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "mistralai/mistral-medium-3.5", name: "Mistral Medium 3.5", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: { levels: ["none", "high"], default: "none" }, price: { input: 0, output: 0 } },
  { id: "mistralai/mistral-small-2603", name: "Mistral Small 4", vendor: "mistral", tier: "free",
    contextWindow: 256_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: { levels: ["none", "high"], default: "none" }, price: { input: 0, output: 0 } },
  { id: "qwen/qwen-plus-2025-07-28:free", name: "Qwen Plus 0728 (Free)", vendor: "qwen", tier: "free",
    contextWindow: 131_072, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3-coder-plus:free", name: "Qwen3 Coder Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_048_576, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3-max:free", name: "Qwen3 Max (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3-omni-flash:free", name: "Qwen3 Omni Flash (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3-vl-plus:free", name: "Qwen3 VL Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.5-397b-a17b:free", name: "Qwen3.5 397B A17B (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.5-flash:free", name: "Qwen3.5 Flash (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.5-omni-flash:free", name: "Qwen3.5 Omni Flash (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.5-omni-plus:free", name: "Qwen3.5 Omni Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: false, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.5-plus:free", name: "Qwen3.5 Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.6-27b:free", name: "Qwen3.6 27B (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.6-35b-a3b:free", name: "Qwen3.6 35B A3B (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.6-max-preview:free", name: "Qwen3.6 Max Preview (Free)", vendor: "qwen", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.6-plus:free", name: "Qwen3.6 Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.7-flash:free", name: "Qwen3.7 Flash (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.7-max:free", name: "Qwen3.7 Max (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.7-plus:free", name: "Qwen3.7 Plus (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.8-max:free", name: "Qwen3.8 Max (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "qwen/qwen3.8-omni-flash:free", name: "Qwen3.8 Omni Flash (Free)", vendor: "qwen", tier: "free",
    contextWindow: 1_000_000, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: null, price: { input: 0, output: 0 } },
  { id: "sensenova/sensenova-6.7-flash-lite", name: "SenseNova 6.7 Flash-Lite", vendor: "api", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: { levels: ["none", "low", "medium", "high"], default: "medium" }, price: { input: 0, output: 0 } },
  { id: "sensenova/sensenova-6.8-flash-lite", name: "SenseNova 6.8 Flash-Lite", vendor: "api", tier: "free",
    contextWindow: 262_144, maxTokens: 65_536, input: ["text","image"], tools: true,
    reasoning: true, effort: { levels: ["none", "low", "medium", "high"], default: "medium" }, price: { input: 0, output: 0 } },
];

/** Index by id for the overlay's "known ids" check. */
export const SNAPSHOT_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  FREE_TIER_SNAPSHOT.map((entry) => [entry.id, entry]),
);
