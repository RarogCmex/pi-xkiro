/**
 * Live discovery: listing parse, entitlement rule, and the two guarantees
 * `fetchModels` must keep — never throw, never shrink the picker because a
 * refresh had a bad moment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  clearEntitlementCache,
  cachedEntitlement,
  clearLastGoodListing,
  ENTITLEMENT_TTL_MS,
  entitlementFromUsage,
  fetchListing,
  fetchXkiroModels,
  parseListing,
  prefetchEntitlements,
  probeEntitlement,
  rememberEntitlement,
  registerTiers,
  tierOf,
  ALL_TIERS,
  FREE_ONLY,
} from "../discovery.ts";

const listingFixture = JSON.parse(readFileSync(new URL("./fixtures/models-sample.json", import.meta.url), "utf8"));
const freeUsage = JSON.parse(readFileSync(new URL("./fixtures/usage-free-account.json", import.meta.url), "utf8"));
const fundedUsage = JSON.parse(readFileSync(new URL("./fixtures/usage-funded-account.json", import.meta.url), "utf8"));

const USABLE = 7; // fixture rows that are chat models with an id

test("parseListing: keeps chat rows, dedupes, drops junk", () => {
  const rows = parseListing(listingFixture);
  assert.equal(rows.length, USABLE);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.deepEqual(
    rows.map((row) => row.tier),
    ["paid", "free", "free", "paid", "free", "paid", "paid"],
  );
  assert.equal(parseListing(undefined).length, 0);
  assert.equal(parseListing({ data: "nope" }).length, 0);
  assert.equal(parseListing({ data: [null, 1, "x", {}] }).length, 0);
});

test("entitlementFromUsage: a zero wallet with no plan unlocks the free tier only", () => {
  const entitlement = entitlementFromUsage(freeUsage);
  assert.equal(entitlement.probed, true);
  assert.deepEqual(entitlement.tiers, FREE_ONLY);
  assert.equal(entitlement.email, "free-account@example.test");
  assert.equal(entitlement.balanceUsd, 0);
  assert.equal(entitlement.freeLimitPerDay, 500_000);
  assert.equal(entitlement.freeRemainingToday, 456_723);
});

test("entitlementFromUsage: a plan unlocks paid and premium", () => {
  assert.deepEqual(entitlementFromUsage(fundedUsage).tiers, ALL_TIERS);
});

test("entitlementFromUsage: a wallet top-up does NOT unlock anything (live 403s, 2026-09-24)", () => {
  // The docs say "an active paid plan or real deposited balance"; measured
  // 2026-09-24, a real non-zero balance on a plan-less account still answered
  // 403 permission_denied on every paid and premium id probed. Registering
  // those models anyway would hand pi a picker full of guaranteed failures.
  for (const balance of ["1.250000", "100.000000", "0.000000"]) {
    const entitlement = entitlementFromUsage({ ...fundedUsage, plan: null, wallet: { balance_usd: balance } });
    assert.deepEqual(entitlement.tiers, FREE_ONLY, `balance ${balance} must not widen the catalog`);
    assert.equal(entitlement.balanceUsd, Number.parseFloat(balance), "still reported for /xkiro");
  }

  const bonusOnly = entitlementFromUsage({ plan: null, wallet: { balance_usd: "0.000000" }, free_tokens: { remaining: 900 } });
  assert.deepEqual(bonusOnly.tiers, FREE_ONLY, "promotional/bonus credits do not unlock paid models");
});

test("entitlementFromUsage: garbage in, locked-catalog out", () => {
  for (const junk of [undefined, null, "string", 7, {}, { plan: 5, wallet: { balance_usd: "NaN" } }]) {
    const entitlement = entitlementFromUsage(junk);
    assert.equal(entitlement.probed, junk !== undefined && junk !== null && typeof junk === "object" && !Array.isArray(junk) ? true : false, `${JSON.stringify(junk)}`);
    assert.deepEqual(entitlement.tiers, FREE_ONLY);
  }
});

test("tier registry: ids known from the listing answer their tier, unknown ids answer undefined", () => {
  registerTiers(parseListing(listingFixture));
  assert.equal(tierOf("openai/gpt-5.6-sol"), "paid");
  assert.equal(tierOf("minimax/minimax-m3:free"), "free");
  assert.equal(tierOf("acme/not-in-any-listing"), undefined);
});

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as unknown as RefreshModelsContext;
}

function fetchOnce(responses: Record<string, { status?: number; body: unknown }>): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const match = Object.entries(responses).find(([path]) => url.endsWith(path));
    if (!match) return new Response("nope", { status: 404 });
    const { status = 200, body } = match[1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

test("fetchXkiroModels: auto entitlement registers free rows and skips gated ones", async () => {
  clearLastGoodListing();
  clearEntitlementCache();
  const fetchImpl = fetchOnce({ "/models": { body: listingFixture }, "/usage": { body: freeUsage } });
  const models = await fetchXkiroModels({
    baseUrl: "https://api.xkiro.com/v1",
    context: context(),
    tiers: "auto",
    resolveKey: () => "sk-xt-test-key",
    fetchImpl,
  });
  assert.equal(models.length, 3, "the fixture has three free chat rows");
  assert.ok(models.every((model) => !/\[(paid|premium)\]$/.test(model.name)));
  assert.ok((fetchImpl as any).calls.every((url: string) => url.startsWith("https://api.xkiro.com/v1/")));
});

test("fetchXkiroModels: a funded account gets the whole listing", async () => {
  clearLastGoodListing();
  clearEntitlementCache();
  const fetchImpl = fetchOnce({ "/models": { body: listingFixture }, "/usage": { body: fundedUsage } });
  const models = await fetchXkiroModels({
    baseUrl: "https://api.xkiro.com/v1",
    context: context(),
    tiers: "auto",
    resolveKey: () => "sk-xt-funded",
    fetchImpl,
  });
  assert.equal(models.length, USABLE);
});

test("fetchXkiroModels: an explicit XKIRO_TIERS list bypasses the probe", async () => {
  clearLastGoodListing();
  const fetchImpl = fetchOnce({ "/models": { body: listingFixture } });
  const models = await fetchXkiroModels({
    baseUrl: "https://api.xkiro.com/v1",
    context: context(),
    tiers: ["free", "paid", "premium"],
    resolveKey: () => "sk-xt-any",
    fetchImpl,
  });
  assert.equal(models.length, USABLE);
  assert.ok((fetchImpl as any).calls.every((url: string) => !url.endsWith("/usage")), "no quota probe when the user decided");
});

test("fetchXkiroModels: a failed listing keeps the previous overlay; offline keeps it too", async () => {
  clearLastGoodListing();
  clearEntitlementCache();
  const good = fetchOnce({ "/models": { body: listingFixture }, "/usage": { body: fundedUsage } });
  assert.equal((await fetchXkiroModels({ baseUrl: "https://api.xkiro.com/v1", context: context(), tiers: "auto", resolveKey: () => "k", fetchImpl: good })).length, USABLE);

  const broken = fetchOnce({ "/models": { status: 503, body: { error: { message: "upstream" } } } });
  const afterFailure = await fetchXkiroModels({ baseUrl: "https://api.xkiro.com/v1", context: context(), tiers: "auto", resolveKey: () => "k", fetchImpl: broken });
  assert.equal(afterFailure.length, USABLE, "a 503 on the catalog must not empty the picker");

  const offline = await fetchXkiroModels({
    baseUrl: "https://api.xkiro.com/v1",
    context: context({ allowNetwork: false }),
    tiers: "auto",
    resolveKey: () => "k",
    fetchImpl: fetchOnce({ "/models": { body: listingFixture } }),
  });
  assert.equal(offline.length, USABLE);
  assert.equal(offline[0]?.provider, "xkiro");
});

test("fetchXkiroModels: a network throw is swallowed, not propagated to pi", async () => {
  clearLastGoodListing();
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const models = await fetchXkiroModels({
    baseUrl: "https://api.xkiro.com/v1",
    context: context(),
    tiers: "auto",
    resolveKey: () => "k",
    fetchImpl: throwing,
  });
  assert.deepEqual(models, []);
});

test("fetchListing / probeEntitlement: no key still reads the public catalog, quota needs one", async () => {
  clearEntitlementCache();
  const fetchImpl = fetchOnce({ "/models": { body: listingFixture } });
  assert.equal((await fetchListing("https://api.xkiro.com/v1", undefined, 1000, fetchImpl)).length, USABLE);
  assert.ok((fetchImpl as any).calls.length === 1);

  const anonymous = await probeEntitlement("https://api.xkiro.com/v1", "sk-xt-missing", 1000, fetchOnce({ "/usage": { status: 401, body: {} } }));
  assert.equal(anonymous.probed, false);
  assert.deepEqual(anonymous.tiers, FREE_ONLY);
});

test("probeEntitlement: a fresh probe is reused, an expired one is re-fetched", async () => {
  clearEntitlementCache();
  let hits = 0;
  const fetchImpl = (async () => {
    hits += 1;
    return new Response(JSON.stringify({ free_tokens: { remaining: 5, limit_per_day: 9 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const first = await probeEntitlement("https://api.xkiro.com/v1", "sk-xt-cached", 1000, fetchImpl);
  const second = await probeEntitlement("https://api.xkiro.com/v1", "sk-xt-cached", 1000, fetchImpl);
  assert.equal(hits, 1, "the transport, /xkiro and the refresh must share one probe per key");
  assert.deepEqual(first.tiers, second.tiers);

  const later = await probeEntitlement("https://api.xkiro.com/v1", "sk-xt-cached", 1000, (async () => {
    hits += 1;
    return new Response(JSON.stringify({ plan: "pro", free_tokens: { remaining: 5, limit_per_day: 9 } }), { status: 200 });
  }) as unknown as typeof fetch);
  assert.deepEqual(later.tiers, second.tiers, "still the cached answer within the TTL");

  rememberEntitlement("sk-xt-cached", { tiers: FREE_ONLY, probed: true }, Date.now() - ENTITLEMENT_TTL_MS - 1);
  await probeEntitlement("https://api.xkiro.com/v1", "sk-xt-cached", 1000, fetchImpl);
  assert.equal(hits, 2, "an expired entry is probed again");
});

test("prefetchEntitlements: measures every account in one pass", async () => {
  clearEntitlementCache();
  let hits = 0;
  const fetchImpl = (async () => {
    hits += 1;
    return new Response(JSON.stringify({ free_tokens: { remaining: 100, limit_per_day: 100 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const measured = await prefetchEntitlements("https://api.xkiro.com/v1", ["a", "b", "c"], 1000, fetchImpl);
  assert.equal(measured.size, 3);
  assert.equal(hits, 3, "once per account, in parallel");
  assert.ok(cachedEntitlement("b"), "and the result is what the gate will later read");
});
