/**
 * Error rewrites. The rule that matters: a rewrite must make pi act correctly
 * (compact on overflow, stop retrying on a tier gate), never merely sound
 * nicer — and a rate limit must never be laundered into a compaction trigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clarifyAuthError,
  clarifyError,
  clarifyQuotaError,
  clarifyTierError,
  clarifyUnavailableError,
  isModelUnavailable,
  normalizeOverflowError,
} from "../errors.ts";

const OVERFLOW =
  "Input is ~164970 tokens, which exceeds the safe limit of 160000 tokens for this model. Shorten the input or use a model with a larger context window.";

test("overflow: xKiro's pre-flight rejection becomes pi's compaction marker", () => {
  const rewritten = normalizeOverflowError(OVERFLOW);
  assert.ok(rewritten, "pi-ai's own patterns do not match 'exceeds the safe limit of'");
  assert.match(rewritten, /^context_length_exceeded: /);
  assert.ok(rewritten.includes("160000"), "the numbers stay, the user needs them");
});

test("overflow: idempotent, and empty/irrelevant messages untouched", () => {
  assert.equal(normalizeOverflowError(`context_length_exceeded: ${OVERFLOW}`), null);
  assert.equal(normalizeOverflowError(""), null);
  assert.equal(normalizeOverflowError("Model \"nope/fake-9000\" does not exist."), null);
  assert.equal(normalizeOverflowError("A server error occurred. Please try again."), null);
});

test("overflow: rate limits and quota are never rewritten into compaction", () => {
  const messages = [
    "429 Too Many Requests: rate limit exceeded",
    "Rate limit: 10 requests per minute",
    "You have exceeded your token quota for today",
    "insufficient_quota: not enough tokens left",
  ];
  for (const message of messages) {
    assert.equal(normalizeOverflowError(message), null, `${message} must stay a rate/quota error`);
  }
});

test("overflow: pass-through upstream phrasings still normalize", () => {
  for (const message of [
    "This model's maximum context length is 8192 tokens",
    "prompt is too long: 200000 tokens > 1000000 maximum",
    "Requested 300000 tokens exceeds the context budget",
  ]) {
    assert.match(normalizeOverflowError(message) ?? "", /^context_length_exceeded: /, message);
  }
});

test("tier gate: the premium refusal becomes actionable and stays non-retryable", () => {
  const tierMessage =
    "This premium model requires an active paid plan or real deposited balance. Subscribe to a plan or top up your wallet to use it — promotional/bonus credits do not apply.";
  const clarified = clarifyTierError(tierMessage);
  assert.ok(clarified);
  assert.match(clarified, /^xkiro: /);
  assert.match(clarified, /депозит/);
  assert.match(clarified, /\/xkiro/);
  assert.equal(clarifyTierError("A server error occurred. Please try again."), undefined);
});

test("tier gate: rewriting twice does not stack", () => {
  const once = clarifyTierError("requires an active paid plan or real deposited balance")!;
  assert.equal(clarifyTierError(once), undefined);
});

test("quota: daily free-token exhaustion names the reset and the pool", () => {
  const clarified = clarifyQuotaError("429 Too many requests: you have hit your daily free token limit");
  assert.ok(clarified);
  assert.match(clarified, /суточная квота/i);
  assert.match(clarified, /XKIRO_API_KEYS/);
  assert.equal(clarifyQuotaError("Model not found"), undefined);
});

test("auth: a 401 says the key is wrong, not the model", () => {
  const clarified = clarifyAuthError('Missing ClientApiKey. Send "Authorization: Bearer <key>" or the "x-api-key" header.');
  assert.ok(clarified);
  assert.match(clarified, /401/);
  assert.match(clarified, /\/login xkiro/);
  assert.equal(clarifyAuthError("permission_denied"), undefined);
});

test("clarifyError: exactly one rewrite, overflow first", () => {
  assert.match(clarifyError(OVERFLOW) ?? "", /^context_length_exceeded: /);
  assert.match(clarifyError("This premium model requires an active paid plan") ?? "", /^xkiro: /);
  assert.equal(clarifyError("A server error occurred. Please try again."), undefined);
  assert.equal(clarifyError(""), undefined);
});

test("clarifyError: a tier-gated overflow-shaped message is not a compaction trigger", () => {
  // xKiro answers 403 with a tier message that mentions "credits"; the
  // overflow regex must not swallow it.
  const message = "This premium model requires real deposited balance — promotional/bonus credits do not apply.";
  assert.match(clarifyError(message) ?? "", /^xkiro: модель платная/);
});

// ---------------------------------------------------------------------------
// Over-capacity: 503 service_unavailable / 429 rate_limit_exceeded on a model
// the free tier shares with everybody else. Measured 2026-11-03: all 19
// qwen/*:free ids answered 429 or 503 while `GET /v1/usage` still showed
// ~930k of the daily free tokens left — so this is the platform, not the key.
// ---------------------------------------------------------------------------

test("unavailable: the two live shapes are recognised, the lookalikes are not", () => {
  assert.equal(
    isModelUnavailable(
      503,
      '503: {"message":"The model is temporarily unavailable due to high demand. Please retry in a moment.","type":"server_error","code":"service_unavailable"}',
    ),
    true,
    "the shape measured on every qwen3.*:free id",
  );
  assert.equal(
    isModelUnavailable(429, '429: {"message":"A server error occurred. Please try again.","type":"rate_limit_error","code":"rate_limit_exceeded"}'),
    true,
    "the 429 that precedes the 503",
  );
  assert.equal(isModelUnavailable(503, "503 Service Unavailable"), false, "a bare CDN 503 proves nothing");
  assert.equal(isModelUnavailable(400, "temporarily unavailable"), false, "a 400 is not a capacity signal");
  assert.equal(isModelUnavailable(429, "429: daily free token limit reached"), false, "quota exhaustion is the account, not the model");
  assert.equal(isModelUnavailable(undefined, "A server error occurred. Please try again."), false, "no status, no fact");
});

test("unavailable: the rewrite names the platform, keeps the status, and is idempotent", () => {
  const raw =
    '503: {"message":"The model is temporarily unavailable due to high demand. Please retry in a moment.","type":"server_error","code":"service_unavailable"}';
  const rewritten = clarifyUnavailableError(raw);
  assert.ok(rewritten);
  assert.match(rewritten, /^xkiro: /);
  assert.match(rewritten, /503/);
  assert.match(rewritten, /503: \{"message"/, "the gateway's own text survives verbatim");
  assert.match(rewritten, /не ключ/i);
  assert.match(rewritten, /\/xkiro reset/);
  assert.equal(clarifyUnavailableError(rewritten!), undefined, "idempotent");
  assert.equal(clarifyUnavailableError("402 insufficient_quota"), undefined);
  assert.equal(clarifyUnavailableError("429 Too Many Requests"), undefined, "a plain rate limit is not a model fact");
});

test("unavailable: clarifyError routes it, and never ahead of overflow or tier", () => {
  const overflow = "Input is ~164970 tokens, which exceeds the safe limit of 160000 tokens for this model.";
  assert.match(clarifyError(overflow)!, /^context_length_exceeded: /, "overflow still wins");
  assert.match(
    clarifyError('403: {"message":"This model is available to paying customers only."}')!,
    /уровня|платн/i,
    "a tier gate is still a tier gate",
  );
  assert.match(clarifyError('503: {"message":"The model is temporarily unavailable due to high demand."}')!, /не ключ/i);
});
