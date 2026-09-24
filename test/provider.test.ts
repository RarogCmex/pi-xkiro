/**
 * Provider assembly and the rotating transport.
 *
 * The transport contract under test is pi's own (custom-provider.md): exactly
 * one `start` per logical request, balanced content events, one terminal
 * `done`/`error`, and cancellation that surfaces as an aborted result rather
 * than a silent retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderResponse,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  BALANCE_BAND,
  balancePool,
  buildXkiroProvider,
  gatedMessage,
  pluralRu,
  poolEntitlement,
  selectKeysForTier,
  describeEntitlement,
  MAX_KEY_ATTEMPTS,
  withKeyRotation,
  xkiroApiKeyAuth,
} from "../provider.ts";
import { XkiroKeyPool } from "../keys.ts";
import { PROVIDER_ID, DEFAULT_BASE_URL, type XkiroApi } from "../models.ts";
import type { XkiroTier } from "../catalog.ts";
import { clearEntitlementCache, rememberEntitlement, tierCounts } from "../discovery.ts";

const K1 = "sk-xt-key-one-1111";
const K2 = "sk-xt-key-two-2222";

const context: TranscriptContext = { messages: [] } as unknown as TranscriptContext;

const model: Model<XkiroApi> = {
  id: "qwen/qwen3.8-max:free",
  name: "Qwen3.8 Max (Free)",
  api: "openai-completions",
  provider: PROVIDER_ID,
  baseUrl: DEFAULT_BASE_URL,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function succeed(text: string): AssistantMessageEvent[] {
  const partial = message({ content: [{ type: "text", text }] });
  return [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    { type: "done", reason: "stop", message: partial },
  ];
}

function fail(errorMessage: string, reason: "error" | "aborted" = "error"): AssistantMessageEvent[] {
  return [{ type: "error", reason, error: message({ stopReason: "error", errorMessage }) }];
}

interface Attempt {
  apiKey?: string;
  sessionId?: string;
  status?: number;
}

/**
 * Fake adapter: yields a scripted event list per call and records the key and
 * session it was handed. `status` is delivered through `onResponse` exactly the
 * way pi's adapter does, so the wrapper's retry decision is exercised on the
 * same signal it will see in production.
 */
function fakeApi(script: Array<(attempt: Attempt) => AssistantMessageEvent[]>) {
  const attempts: Attempt[] = [];
  const api: ProviderStreams = {
    stream: (m, context, options) => run(m, context, options),
    streamSimple: (m, context, options) => run(m, context, options),
  };
  function run(
    requested: Parameters<NonNullable<ProviderStreams["stream"]>>[0],
    context: TranscriptContext,
    options?: StreamOptions | SimpleStreamOptions,
  ) {
    const index = attempts.length;
    const attempt: Attempt = { apiKey: options?.apiKey, sessionId: options?.sessionId };
    attempts.push(attempt);
    const events = script[Math.min(index, script.length - 1)](attempt);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (attempt.status !== undefined && options?.onResponse) {
        const response: ProviderResponse = { status: attempt.status, headers: {} };
        void options.onResponse(response, requested);
      }
      for (const event of events) stream.push(event);
      stream.end();
    });
    return stream;
  }
  return { api, attempts };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Script one outcome, optionally carrying an HTTP status for the retry rule. */
function outcome(events: AssistantMessageEvent[], status?: number): (attempt: Attempt) => AssistantMessageEvent[] {
  return (attempt) => {
    attempt.status = status;
    return events;
  };
}

/** `notify` carries info/warning/error events; only the text matters here. */
function noticeText(event: unknown): string {
  return String((event as { message?: string }).message ?? JSON.stringify(event));
}

function poolOf(env: Record<string, string | undefined> = {}): XkiroKeyPool {
  return new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2}`, ...env } });
}

test("rotation: a plain success passes every event through and records nothing", async () => {
  const fake = fakeApi([outcome(succeed("pong"))]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: "unused", sessionId: "s1" }));

  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [K1]);
  assert.equal(pool.status().every((entry) => entry.failures === 0), true);
});

test("rotation: a 429 before any output moves the request to the next account", async () => {
  const fake = fakeApi([
    outcome(fail("429 Too Many Requests")),
    outcome(succeed("pong")),
  ]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  // The adapter reports the status through onResponse, like pi's does.
  const events = await collect(api.streamSimple(model, context, { apiKey: K1, sessionId: "s1" }));

  assert.equal(events.filter((event) => event.type === "start").length, 1, "one start per logical request");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
    "the failed attempt must not leak its error event",
  );
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [K1, K2]);
});

test("rotation: the HTTP status, not the prose, drives the retry", async () => {
  // pi-ai composes `errorMessage` from whatever the SDK surfaced; an opaque
  // body is still a 429 as far as the gateway answered.
  const fake = fakeApi([outcome(fail("GatewayError"), 429), outcome(succeed("pong"), 200)]);
  const pool = poolOf();
  const events = await collect(
    withKeyRotation(fake.api, pool, { sleep: async () => {} }).streamSimple(model, context, { apiKey: K1, sessionId: "s1" }),
  );
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [K1, K2]);
  assert.equal(events.at(-1)?.type, "done");

  // Same opaque text with a 400 must not be treated as capacity.
  const hard = fakeApi([outcome(fail("Bad Request"), 400)]);
  const hardEvents = await collect(
    withKeyRotation(hard.api, poolOf(), { sleep: async () => {} }).streamSimple(model, context, { apiKey: K1, sessionId: "s2" }),
  );
  assert.equal(hard.attempts.length, 1);
  assert.equal(hardEvents.at(-1)?.type, "error");
});

test("rotation: nothing is retried once content is on screen", async () => {
  const half = [
    { type: "start", partial: message() },
    { type: "text_start", contentIndex: 0, partial: message() },
    ...fail("Connection closed mid-stream"),
  ] as AssistantMessageEvent[];
  const fake = fakeApi([outcome(half)]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: K1, sessionId: "s1" }));

  assert.equal(fake.attempts.length, 1, "a half-delivered answer is not restarted behind the user's back");
  assert.equal(events.at(-1)?.type, "error");
});

test("rotation: user cancellation is not a capacity failure", async () => {
  const fake = fakeApi([outcome(fail("Request was aborted", "aborted"))]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: K1, sessionId: "s1" }));

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(fake.attempts.length, 1);
  assert.equal(pool.status().every((entry) => entry.coolingMs === 0), true, "no key may be parked for a cancel");
});

test("rotation: a tier 403 surfaces unchanged and parks nobody", async () => {
  const fake = fakeApi([
    outcome(fail("This premium model requires an active paid plan or real deposited balance")),
  ]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: K1, sessionId: "s1" }));
  assert.equal(fake.attempts.length, 1);
  const last = events.at(-1);
  assert.ok(last && last.type === "error");
  assert.match(last.error.errorMessage ?? "", /paid plan/);
  assert.equal(pool.status().every((entry) => entry.coolingMs === 0), true);
});

test("rotation: the pool size caps the attempts, and the last error is still surfaced", async () => {
  const fake = fakeApi([outcome(fail("A server error occurred. Please try again."))]);
  const pool = poolOf();
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: K1, sessionId: "s1" }));

  assert.equal(fake.attempts.length, 2, "two accounts, two tries: MAX_KEY_ATTEMPTS is a cap, not a quota");
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [K1, K2]);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.filter((event) => event.type === "start").length, 0, "no content was ever produced");
  assert.equal(pool.status().every((entry) => entry.coolingMs > 0), true);

  const wider = fakeApi([outcome(fail("A server error occurred. Please try again."))]);
  const widePool = new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2},sk-xt-key-three-3333` } });
  await collect(withKeyRotation(wider.api, widePool, { sleep: async () => {} }).streamSimple(model, context, { apiKey: K1, sessionId: "s9" }));
  assert.equal(wider.attempts.length, MAX_KEY_ATTEMPTS, "more accounts than the cap → the cap wins, pi's own retry handles the rest");
});

test("rotation: an empty pool falls back to the key pi resolved instead of failing", async () => {
  const fake = fakeApi([outcome(succeed("pong"))]);
  const pool = new XkiroKeyPool({ env: {} });
  const api = withKeyRotation(fake.api, pool, { sleep: async () => {} });
  const events = await collect(api.streamSimple(model, context, { apiKey: K2, sessionId: "s1" }));
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [K2]);
  assert.deepEqual(pool.all(), [K2]);
});

test("rotation: `stream` is wired the same way as `streamSimple`", async () => {
  const fake = fakeApi([outcome(succeed("pong"))]);
  const api = withKeyRotation(fake.api, poolOf(), { sleep: async () => {} });
  const events = await collect(api.stream(model, context, { apiKey: K1, sessionId: "s2" }));
  assert.equal(events.at(-1)?.type, "done");
});

test("auth.resolve: stored credential wins and seeds the pool", async () => {
  const pool = new XkiroKeyPool({ env: {} });
  const auth = xkiroApiKeyAuth(DEFAULT_BASE_URL, pool);
  const ctx = { env: async () => K2, fileExists: async () => false };
  const stored = await auth.resolve({ ctx, credential: { type: "api_key", key: ` ${K1} ` }, signal: new AbortController().signal });
  assert.equal(stored?.auth.apiKey, K1, "trimmed before it reaches the header");
  assert.deepEqual(pool.all(), [K1]);

  const ambient = await auth.resolve({ ctx, credential: undefined, signal: new AbortController().signal });
  assert.equal(ambient?.auth.apiKey, K2);
  assert.deepEqual(pool.all(), [K1, K2]);

  const none = await auth.resolve({
    ctx: { env: async () => undefined, fileExists: async () => false },
    credential: undefined,
    signal: new AbortController().signal,
  });
  assert.equal(none, undefined);
});

test("auth.login: a valid key reports its account, an invalid one is not saved", async () => {
  clearEntitlementCache();
  const listingFixture = JSON.parse(readFileSync(new URL("./fixtures/models-sample.json", import.meta.url), "utf8"));
  const freeUsage = JSON.parse(readFileSync(new URL("./fixtures/usage-free-account.json", import.meta.url), "utf8"));
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/usage")) return new Response(JSON.stringify(freeUsage), { status: 200 });
    if (url.endsWith("/models")) return new Response(JSON.stringify(listingFixture), { status: 200 });
    return new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;

  const notices: string[] = [];
  const auth = xkiroApiKeyAuth(DEFAULT_BASE_URL, new XkiroKeyPool({ env: {} }), fetchImpl);
  const credential = await auth.login!({
    signal: new AbortController().signal,
    prompt: async () => `  ${K1}\n`,
    notify: (event) => {
      notices.push(noticeText(event));
    },
  });
  assert.deepEqual(credential, { type: "api_key", key: K1 }, "the trailing newline from a paste is stripped");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /free-account@example.test/);
  assert.match(notices[0], /уровни free/);
  assert.match(notices[0], /осталось 456,723 из 500,000 бесплатных токенов сегодня/);
  assert.match(notices[0], /доступно 3\/7/);

  clearEntitlementCache(); // the probe above cached K1; a login must re-ask the gateway
  const rejected = xkiroApiKeyAuth(DEFAULT_BASE_URL, new XkiroKeyPool({ env: {} }), (async () =>
    new Response("{}", { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(
    () => rejected.login!({ signal: new AbortController().signal, prompt: async () => K1, notify: () => {
      } }),
    /не принял ключ/,
  );

  clearEntitlementCache();
  const prefixNotices: string[] = [];
  const wrongShape = await xkiroApiKeyAuth(DEFAULT_BASE_URL, new XkiroKeyPool({ env: {} }), fetchImpl).login!({
    signal: new AbortController().signal,
    prompt: async () => "sk-not-xkiro",
    notify: (event) => {
      prefixNotices.push(noticeText(event));
    },
  });
  assert.equal(wrongShape.key, "sk-not-xkiro", "a non-conforming prefix warns but is still saved");
  assert.match(prefixNotices[0] ?? "", /sk-xt-/, "warned about the prefix first");
  assert.equal(prefixNotices.length, 2);

  await assert.rejects(
    () => xkiroApiKeyAuth(DEFAULT_BASE_URL, new XkiroKeyPool({ env: {} }), fetchImpl).login!({
      signal: new AbortController().signal,
      prompt: async () => "   ",
      notify: () => {
      },
    }),
    /No API key entered/,
  );
});

test("describeEntitlement: readable for both states", () => {
  const line = describeEntitlement(
    { tiers: ["free"], probed: true, email: "a@b.test", freeRemainingToday: 100, freeLimitPerDay: 500 },
    120,
    37,
  );
  assert.equal(
    line,
    "a@b.test · уровни free · осталось 100 из 500 бесплатных токенов сегодня · моделей доступно 37/120 (нужен депозит для платных)",
  );
});

test("buildXkiroProvider: registers the free snapshot offline and filters by entitlement", async () => {
  clearEntitlementCache();
  const provider = buildXkiroProvider({ "openai-completions": fakeApi([outcome(succeed("x"))]).api }, {
    env: {},
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
  const models = provider.getModels();
  assert.ok(models.length >= 30);
  assert.ok(models.every((entry) => entry.provider === PROVIDER_ID && entry.api === "openai-completions"));
  assert.ok(models.every((entry) => entry.baseUrl === DEFAULT_BASE_URL));

  const paidId = "openai/gpt-5.6-sol";
  const all = [...models, { ...model, id: paidId }];
  assert.equal(all.filter((entry) => entry.id === paidId).length, 1);
  assert.equal(provider.filterModels!(all, { type: "api_key", key: "no-cache" }), all, "unknown account → nothing hidden");

  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  const filtered = provider.filterModels!(all, { type: "api_key", key: K1 });
  assert.equal(
    filtered.some((entry) => entry.id === paidId),
    false,
    "a free-only account must not be offered a gated model",
  );
});

test("balancePool: orders by remaining quota and spreads simultaneous starts", async () => {
  const usage = (remaining: number) => ({
    plan: null,
    user: { email: "x@example.test" },
    free_tokens: { used_today: 1_000_000 - remaining, limit_per_day: 1_000_000, remaining },
    wallet: { balance_usd: "0.000000" },
  });
  // Three accounts: two with a near-equal remaining quota (900k, 880k) and one
  // already drained (40k). One response body per key, in configured order.
  const bodies = [900_000, 880_000, 40_000];
  let index = 0;
  const ordered = (async (input: RequestInfo | URL) => {
    void input;
    const body = usage(bodies[index++] ?? 0);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const pool = new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2},sk-xt-key-three-3333` } });
  await clearEntitlementCache();
  const keys = await balancePool(pool, DEFAULT_BASE_URL, { timeoutMs: 1000, fetchImpl: ordered });
  assert.equal(keys.length, 3);
  assert.equal(keys[2], "sk-xt-key-three-3333", "the drained account goes last regardless of shuffle");
  assert.ok([K1, K2].includes(keys[0] as string) && [K1, K2].includes(keys[1] as string));

  // The band is shuffled, so repeated balancing of equal accounts does not
  // always produce the same first key (which is what spreads concurrent pi
  // processes); outside the band the order is stable.
  const seen = new Set<string>();
  for (let round = 0; round < 40; round++) {
    clearEntitlementCache();
    const fresh = new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2},sk-xt-key-three-3333` } });
    let i = 0;
    const fetch2 = (async () => new Response(JSON.stringify(usage(bodies[i++] ?? 0)), { status: 200 })) as unknown as typeof fetch;
    seen.add((await balancePool(fresh, DEFAULT_BASE_URL, { timeoutMs: 1000, fetchImpl: fetch2 }))[0] as string);
  }
  assert.equal(seen.size, 2, "two near-equal leaders must both get picked first sometimes");
});

test("balancePool: unanswered probes keep their slot behind answering keys", async () => {
  clearEntitlementCache();
  const pool = new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2}` } });
  let i = 0;
  const fetchImpl = (async () =>
    i++ === 0
      ? new Response(JSON.stringify({ error: { code: "authentication_error" } }), { status: 401 })
      : new Response(JSON.stringify({ free_tokens: { remaining: 10, limit_per_day: 1000 } }), { status: 200 })) as unknown as typeof fetch;
  const keys = await balancePool(pool, DEFAULT_BASE_URL, { timeoutMs: 1000, fetchImpl });
  assert.deepEqual(keys, [K2, K1], "the account that answered wins even with 10 tokens left");
});

test("balancePool: a single-key pool is a no-op", async () => {
  const pool = new XkiroKeyPool({ env: { XKIRO_API_KEY: K1 } });
  const fetchImpl = (async () => {
    throw new Error("must not probe");
  }) as unknown as typeof fetch;
  assert.deepEqual(await balancePool(pool, DEFAULT_BASE_URL, { fetchImpl }), [K1]);
});

// ---------------------------------------------------------------------------
// Free-tier gating: a model no account in the pool can run must not be asked
// of the gateway at all.
// ---------------------------------------------------------------------------

const PAID_MODEL: Model<XkiroApi> = { ...model, id: "openai/gpt-5.6-sol" };
const PLAN_KEY = "sk-xt-key-plan-5555";

function poolWithPlan(): XkiroKeyPool {
  return new XkiroKeyPool({ env: { XKIRO_API_KEYS: `${K1},${K2},${PLAN_KEY}` } });
}

test("selectKeysForTier: free models and unseen ids are never gated", () => {
  const view = {
    tierOf: (id: string) => (id === PAID_MODEL.id ? ("paid" as const) : id === "mysterious/new" ? undefined : ("free" as const)),
    entitlementOf: () => ({ tiers: ["free"] as XkiroTier[], probed: true }),
  };
  assert.deepEqual(selectKeysForTier(model.id, [K1], view), { kind: "unknown" });
  assert.deepEqual(selectKeysForTier("mysterious/new", [K1], view), { kind: "unknown" }, "an id we have never seen is not a denial");
});

test("selectKeysForTier: blocked only when EVERY measured account is free-only", () => {
  const freeOnly = { tiers: ["free"] as XkiroTier[], probed: true };
  const planned = { tiers: ["free", "paid", "premium"] as XkiroTier[], probed: true };
  const tierOfPaid = (id: string) => (id === PAID_MODEL.id ? ("paid" as const) : undefined);

  assert.deepEqual(selectKeysForTier(PAID_MODEL.id, [K1, K2], { tierOf: tierOfPaid, entitlementOf: () => freeOnly }), {
    kind: "blocked",
    tier: "paid",
  });
  assert.deepEqual(
    selectKeysForTier(PAID_MODEL.id, [K1, K2], { tierOf: tierOfPaid, entitlementOf: (key) => (key === K2 ? planned : freeOnly) }),
    { kind: "restricted", keys: [K2] },
    "one plan-holding account is enough to send it — pinned to that account",
  );
  assert.deepEqual(
    selectKeysForTier(PAID_MODEL.id, [K1, K2], { tierOf: tierOfPaid, entitlementOf: (key) => (key === K2 ? undefined : freeOnly) }),
    { kind: "unknown" },
    "an unmeasured account gets the benefit of the doubt",
  );
  assert.deepEqual(selectKeysForTier(PAID_MODEL.id, [], { tierOf: tierOfPaid, entitlementOf: () => undefined }), { kind: "unknown" });
});

test("gating: a paid model on a free-only pool is refused without touching the network", async () => {
  clearEntitlementCache();
  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  rememberEntitlement(K2, { tiers: ["free"], probed: true });
  const fake = fakeApi([outcome(succeed("pong"))]);
  const events = await collect(
    withKeyRotation(fake.api, poolOf(), { sleep: async () => {} }).streamSimple(PAID_MODEL, context, { apiKey: K1, sessionId: "s1" }),
  );
  assert.equal(fake.attempts.length, 0, "the whole point: no request, no 95-second wait, no upstream bill");
  const last = events.at(-1);
  assert.ok(last && last.type === "error");
  assert.match(last.error.errorMessage ?? "", /XKIRO_BLOCK_GATED=off/);
  assert.match(last.error.errorMessage ?? "", /403 permission_denied/);
});

test("gating: a mixed pool routes the paid model to the account that can run it", async () => {
  clearEntitlementCache();
  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  rememberEntitlement(K2, { tiers: ["free"], probed: true });
  rememberEntitlement(PLAN_KEY, { tiers: ["free", "paid", "premium"], probed: true });
  const fake = fakeApi([outcome(succeed("pong"))]);
  const events = await collect(
    withKeyRotation(fake.api, poolWithPlan(), { sleep: async () => {} }).streamSimple(PAID_MODEL, context, {
      apiKey: K1,
      sessionId: "s1",
    }),
  );
  assert.deepEqual(fake.attempts.map((attempt) => attempt.apiKey), [PLAN_KEY]);
  assert.equal(events.at(-1)?.type, "done");
});

test("gating: XKIRO_BLOCK_GATED=off lets the request through to get a real answer", async () => {
  clearEntitlementCache();
  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  rememberEntitlement(K2, { tiers: ["free"], probed: true });
  const fake = fakeApi([outcome(fail("permission_denied"), 403)]);
  const pool = poolOf();
  const events = await collect(
    withKeyRotation(fake.api, pool, { gating: false, sleep: async () => {} }).streamSimple(PAID_MODEL, context, {
      apiKey: K1,
      sessionId: "s1",
    }),
  );
  assert.equal(fake.attempts.length, 1, "sent, and answered 403 as the gateway does");
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(pool.status().every((entry) => entry.coolingMs === 0), true, "a 403 is not a capacity signal");
});

test("gating: an entitlement we never measured must not hide or block anything", async () => {
  clearEntitlementCache();
  const fake = fakeApi([outcome(succeed("pong"))]);
  const events = await collect(
    withKeyRotation(fake.api, poolOf(), { sleep: async () => {} }).streamSimple(PAID_MODEL, context, { apiKey: K1, sessionId: "s1" }),
  );
  assert.equal(fake.attempts.length, 1, "unknown account → ask the gateway, do not guess");
  assert.equal(events.at(-1)?.type, "done");
});

test("poolEntitlement: union over the pool, undefined when nothing is measured", () => {
  clearEntitlementCache();
  const pool = poolWithPlan();
  assert.equal(poolEntitlement(pool), undefined);
  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  assert.deepEqual(poolEntitlement(pool)!.tiers, ["free"]);
  rememberEntitlement(PLAN_KEY, { tiers: ["free", "paid"], probed: true });
  assert.deepEqual(poolEntitlement(pool)!.tiers.sort(), ["free", "paid"]);
});

test("filterModels: an explicit XKIRO_TIERS list is not filtered back down", async () => {
  clearEntitlementCache();
  rememberEntitlement(K1, { tiers: ["free"], probed: true });
  const fake = fakeApi([outcome(succeed("x"))]);
  const widened = buildXkiroProvider(
    { "openai-completions": fake.api },
    { env: { XKIRO_TIERS: "free,paid,premium" }, baseUrl: DEFAULT_BASE_URL },
  );
  const all = [...widened.getModels(), { ...PAID_MODEL }];
  const kept = widened.filterModels!(all, { type: "api_key", key: K1 });
  assert.equal(kept.length, all.length, "the user asked for every tier; entitlement detection must not undo it");

  const automatic = buildXkiroProvider({ "openai-completions": fake.api }, { env: {}, baseUrl: DEFAULT_BASE_URL });
  const filtered = automatic.filterModels!(all, { type: "api_key", key: K1 });
  assert.ok(filtered.length < all.length, "auto mode does hide gated ids once the account is known");
});

test("pluralRu: russian counts read correctly", () => {
  assert.equal(pluralRu(1, "модель", "модели", "моделей"), "модель");
  assert.equal(pluralRu(2, "модель", "модели", "моделей"), "модели");
  assert.equal(pluralRu(5, "модель", "модели", "моделей"), "моделей");
  assert.equal(pluralRu(11, "модель", "модели", "моделей"), "моделей");
  assert.equal(pluralRu(21, "модель", "модели", "моделей"), "модель");
  assert.equal(pluralRu(42, "модель", "модели", "моделей"), "модели");
});

test("gatedMessage: counts come from the catalog, not from a captured constant", () => {
  const message = gatedMessage("openai/gpt-5.6-sol", "paid", 3);
  assert.match(message, /openai\/gpt-5\.6-sol уровня "paid"/);
  assert.match(message, /на 3 аккаунтах/);
  assert.match(message, /403 permission_denied/);
  assert.match(message, /XKIRO_BLOCK_GATED=off/);
  const free = tierCounts().free;
  assert.match(message, new RegExp(`Открыта сейчас ${free} `), "the number must track the live catalog");
  assert.ok(!/37 id/.test(message), "no baked-in catalog size");
});
