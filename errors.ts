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
 *     compaction would never fire. Same contract as the sibling plugins:
 *     prepend the `context_length_exceeded:` marker pi's classifier looks for.
 *     Rate limits must never be rewritten into a compaction trigger.
 *
 *  2. Tier gating. `403 permission_denied` on a `paid`/`premium` model reads
 *     like a broken key ("requires an active paid plan or real deposited
 *     balance … promotional/bonus credits do not apply"). It is not an auth
 *     bug and no retry helps, so name the actual cause and the actual fix.
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

/** `403 permission_error` / `permission_denied` on a gated tier. */
const TIER_ERROR_RE =
  /requires an active paid plan|real deposited balance|promotional\/bonus credits|permission_denied/i;

/** Actionable text for tier gating, or undefined when the message is something else. */
export function clarifyTierError(message: string): string | undefined {
  if (!TIER_ERROR_RE.test(message)) return undefined;
  if (message.startsWith("xkiro:")) return undefined;
  return (
    "xkiro: модель платная/премиальная, а на аккаунте этого ключа нет реального депозита или плана " +
    "(промо- и бонусные кредиты не считаются). " +
    "Возьмите модель из бесплатного уровня (`/xkiro` покажет, что открыто текущему ключу), " +
    "или пополните кошелёк на xkiro.com. Повтор запроса ничего не изменит."
  );
}

/** Daily free-quota exhaustion and empty wallet: `429 rate_limit_exceeded` /
 *  `402 insufficient_quota` (docs /api/errors/ status table). */
const QUOTA_RE =
  /insufficient[ _-]?quota| insufficient balance|daily (?:free )?(?:token )?limit|free_tokens|limit_per_day|exhausted for today|usage limit reached/i;

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

/** Everything the message hooks run, in order. First rewrite wins. */
export function clarifyError(message: string): string | undefined {
  return (
    normalizeOverflowError(message) ??
    clarifyTierError(message) ??
    clarifyQuotaError(message) ??
    clarifyAuthError(message)
  );
}
