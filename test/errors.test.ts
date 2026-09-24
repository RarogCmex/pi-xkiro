/**
 * Error rewrites. The rule that matters: a rewrite must make pi act correctly
 * (compact on overflow, stop retrying on a tier gate), never merely sound
 * nicer — and a rate limit must never be laundered into a compaction trigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clarifyAuthError, clarifyError, clarifyQuotaError, clarifyTierError, normalizeOverflowError } from "../errors.ts";

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
