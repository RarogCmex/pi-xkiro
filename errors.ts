/**
 * Error-message normalization for the xKiro gateway.
 *
 * xKiro answers OpenAI-shaped errors on both dialects:
 * `{ "error": { "message", "type", "code" } }`, and pi-ai folds the SDK error
 * into `AssistantMessage.errorMessage`. Two of its responses need a rewrite
 * before pi can act on them (verified live 2026-09-24, see README "Проверено"):
 *
 *  1. Context overflow. xKiro pre-empts the upstream with
 *     `400 invalid_request_error` / "Input is ~164970 tokens, which exceeds
 *     the safe limit of 160000 tokens for this model." None of pi-ai's
 *     `OVERFLOW_PATTERNS` match that phrasing — `/exceeds the limit of \d+/`
 *     is GitHub Copilot's wording and "the **safe** limit" breaks it — so auto
 *     compaction would never fire. The fix is to prepend the
 *     `context_length_exceeded:` marker pi's classifier looks for.
 *     Rate limits must never be rewritten into a compaction trigger.
 *
 *  2. Tier gating. `403 permission_denied` on a `paid`/`premium` model reads
 *     like a broken key ("requires an active paid plan or real deposited
 *     balance … promotional/bonus credits do not apply"). It is not an auth
 *     bug and no retry helps, so name the actual cause and the actual fix.
 *     The same 403 also arrives for ids the listing publishes as `free` (probed
 *     2026-10-08, `meta/muse-spark-1.2-contributor:free`: `access_tier:"free"`,
 *     price 0/0, and "available to paying customers only"), which is a
 *     different wording and a different consequence — see `isTierDenial`.
 */

/** xKiro's own overflow wording (docs /api/errors/, "Context window exceeded"),
 *  plus the generic OpenAI-compatible phrasings the gateway may pass through
 *  from an upstream. */
const CONTEXT_OVERFLOW_RE =
  /context_length_exceeded|exceeds the (?:safe|maximum|model)? ?limit of \d+|exceeds the (?:context|token)|maximum context length|prompt is too long|too many tokens|input is ~?\d+ tokens|token limit exceeded|request_too_large/i;

/** Anything rate-shaped. Checked first: a 429 whose text happens to mention
 *  tokens must stay a 429. */
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|\bRPM\b|\bTPM\b|\bRPD\b|\bTPD\b|\bquota\b/i;

export function normalizeOverflowError(errorMessage: string): string | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith("context_length_exceeded")) return null;
  if (RATE_LIMIT_RE.test(errorMessage)) return null;
  if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
  return `context_length_exceeded: ${errorMessage}`;
}

/** `403 permission_error` / `permission_denied` on a gated tier. Both live
 *  wordings, because the gateway has two: `paid`/`premium` ids say "requires an
 *  active paid plan or real deposited balance", while an id the listing
 *  publishes as `free` says "available to paying customers only" (probed
 *  2026-10-08). Matching only the first leaves the mislabelled model's refusal
 *  unexplained — and unexplained is exactly how it reads as a broken key. */
const TIER_ERROR_RE =
  /requires an active paid plan|real deposited balance|promotional\/bonus credits|available to paying customers|permission_denied|permission_error/i;

/** Actionable text for tier gating, or undefined when the message is something else. */
export function clarifyTierError(message: string): string | undefined {
  if (!TIER_ERROR_RE.test(message)) return undefined;
  if (message.startsWith("xkiro:")) return undefined;
  return (
    "xkiro: модель платная/премиальная, а на аккаунте этого ключа нет реального депозита или плана " +
    "(промо- и бонусные кредиты не считаются). " +
    "Возьмите модель из бесплатного уровня (`/xkiro` покажет, что открыто текущему ключу), " +
    "или пополните кошелёк на xkiro.com. Повтор запроса ничего не изменит: " +
    "отказ запомнен, и модель скрыта из /model для этого аккаунта (сброс — /xkiro reset)."
  );
}

/**
 * Is this refusal the gateway saying the MODEL is above this account — as
 * opposed to the key, the request, or the gateway being unwell?
 *
 * The wording is the evidence and the status only corroborates it. pi-ai
 * composes `errorMessage` as either the SDK's own message or `"<status>: <body>"`
 * (`formatProviderError` in pi-ai's utils/error-body), so both shapes reach us;
 * a body that never arrived must not be guessed at. A CDN's bare
 * `403 Forbidden` is not a tier fact, and learning it as one would hide a model
 * that works — so a 403 without tier wording is deliberately NOT a denial, and
 * tier wording under any other status is not one either.
 *
 * Callers treat a `true` as a measurement, not as a key failure: the key is
 * never parked for it, and `reportTierDenial` (discovery.ts) records what the
 * gateway actually enforces for that id.
 */
export function isTierDenial(status: number | undefined, message: string): boolean {
  if (!message || !TIER_ERROR_RE.test(message)) return false;
  return status === undefined || status === 403;
}

/** Daily free-quota exhaustion and empty wallet: `429 rate_limit_exceeded` /
 *  `402 insufficient_quota` (docs /api/errors/ status table). */
const QUOTA_RE =
  /insufficient[ _-]?quota|insufficient balance|daily (?:free )?(?:token )?limit|free_tokens|limit_per_day|exhausted for today|usage limit reached/i;

export function clarifyQuotaError(message: string): string | undefined {
  if (!QUOTA_RE.test(message)) return undefined;
  if (message.startsWith("xkiro:")) return undefined;
  return (
    "xkiro: суточная квота бесплатных токенов на этом аккаунте исчерпана (лимит считается на аккаунт, " +
    "не на запрос; `GET /v1/usage` показывает used_today/limit_per_day). " +
    "Дождись сброса суток, возьми ключ с другого аккаунта в XKIRO_API_KEYS или пополните баланс."
  );
}

/** `401 authentication_error` — the gateway is explicit that either header
 *  form is accepted, so a 401 always means the key itself. */
const AUTH_RE = /authentication_error|invalid or disabled clientapikey|missing clientapikey/i;

export function clarifyAuthError(message: string): string | undefined {
  if (!AUTH_RE.test(message)) return undefined;
  if (message.startsWith("xkiro:")) return undefined;
  return (
    "xkiro: ключ не принят (401 — невалидный/отозванный или с лишним пробелом/переносом строки). " +
    "Проверьте ключ и выполните /login xkiro заново, либо обновите XKIRO_API_KEY / XKIRO_API_KEYS."
  );
}

// ---------------------------------------------------------------------------
// Over capacity: `503 service_unavailable` and the `429 rate_limit_exceeded`
// that precedes it on the ids whose free tier the whole platform shares.
//
// Measured 2026-11-03 while probing all 45 `free` ids: every qwen3.*:free id
// answered either the 429 or the 503 for minutes on end, on four different
// accounts, while `GET /v1/usage` still reported ~930k of that account's daily
// free tokens unspent. That combination is what separates this from the quota
// path above: the account is fine, the model is not being handed out.
// ---------------------------------------------------------------------------

/** The gateway's two over-capacity wordings, verbatim. */
const UNAVAILABLE_RE = /temporarily unavailable|due to high demand|service_unavailable/i;

/**
 * Is this refusal about the MODEL's supply rather than about this account?
 *
 * The status argues, the wording decides. A bare `503 Service Unavailable` from
 * a CDN says nothing about the model, and a `400` carrying "temporarily
 * unavailable" is a different bug — so neither counts. On the `429` side the
 * body must name `rate_limit_exceeded` AND must not be quota exhaustion: the
 * account's daily free tokens running out is an account fact, and hiding the
 * model for it would be a lie.
 */
export function isModelUnavailable(status: number | undefined, message: string): boolean {
  if (!message) return false;
  if (status === 503) return UNAVAILABLE_RE.test(message);
  if (status === 429) return /rate_limit_exceeded/i.test(message) && !QUOTA_RE.test(message);
  return false;
}

/**
 * Actionable text for an over-capacity refusal. Keeps the status and the
 * gateway's own words: a user pasting this into a ticket should not lose them.
 * Idempotent through the same `xkiro:` guard every other rewrite uses.
 */
export function clarifyUnavailableError(message: string): string | undefined {
  if (message.startsWith("xkiro:")) return undefined;
  const overCapacity =
    UNAVAILABLE_RE.test(message) ||
    (/rate_limit_exceeded/i.test(message) && !QUOTA_RE.test(message));
  if (!overCapacity) return undefined;
  if (QUOTA_RE.test(message)) return undefined;
  return (
    "xkiro: модель сейчас не отдаётся — шлюз перегружен или упёрся в лимит на бесплатном уровне " +
    "(это не ключ и не баланс: квота аккаунта тут ни при чём, повтор на другом ключе даст то же самое). " +
    "Подожди несколько минут или выбери другую модель через /model; /xkiro models покажет, " +
    "что помечено недоступным, а /xkiro reset снимает пометку. " +
    message
  );
}

/** Everything the message hooks run, in order. First rewrite wins. */
export function clarifyError(message: string): string | undefined {
  return (
    normalizeOverflowError(message) ??
    clarifyTierError(message) ??
    clarifyQuotaError(message) ??
    clarifyUnavailableError(message) ??
    clarifyAuthError(message)
  );
}
