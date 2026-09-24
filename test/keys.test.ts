/**
 * Key pool: sources, sticky-per-session selection, cooldowns, and the rule
 * that a printed status never contains key material.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COOLDOWN_AUTH_MS,
  COOLDOWN_QUOTA_MS,
  COOLDOWN_RATE_MS,
  failureKindForMessage,
  failureKindForStatus,
  fingerprint,
  parseInlineKeys,
  parseKeysFileContent,
  rotationEnabled,
  XkiroKeyPool,
} from "../keys.ts";

const K1 = "sk-xt-oneeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0001";
const K2 = "sk-xt-twotwoooooooooooooooooooooooooooooooooooooooo0002";
const K3 = "sk-xt-threeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0003";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function pool(env: Record<string, string | undefined>, time = clock(), warnings: string[] = []) {
  return {
    pool: new XkiroKeyPool({ env, now: () => time.now(), onWarn: (message) => warnings.push(message) }),
    warnings,
  };
}

test("parseInlineKeys: comma list, trimmed, empties dropped", () => {
  assert.deepEqual(parseInlineKeys(undefined), []);
  assert.deepEqual(parseInlineKeys("  "), []);
  assert.deepEqual(parseInlineKeys(`${K1}, ${K2},,`), [K1, K2]);
});

test("parseKeysFileContent: array, object form, and every malformed shape", () => {
  assert.deepEqual(parseKeysFileContent(`["${K1}","${K2}"]`).keys, [K1, K2]);
  assert.deepEqual(parseKeysFileContent(`{"keys":["${K1}"]}`).keys, [K1]);
  assert.ok(parseKeysFileContent("{").error);
  assert.ok(parseKeysFileContent('{"keys":"nope"}').error);
  assert.ok(parseKeysFileContent('["ok","",1]').error);
  assert.ok(parseKeysFileContent('"just a string"').error);
});

test("fingerprint: stable, non-reversible-ish, tail-only", () => {
  assert.equal(fingerprint(K1), fingerprint(K1));
  assert.notEqual(fingerprint(K1), fingerprint(K2));
  assert.ok(fingerprint(K1).endsWith(K1.slice(-4)));
  assert.ok(!fingerprint(K1).includes(K1.slice(6, -6)), "no interior key material");
});

test("rotationEnabled: on unless switched off explicitly", () => {
  assert.equal(rotationEnabled({}), true);
  assert.equal(rotationEnabled({ XKIRO_KEY_ROTATION: "" }), true);
  assert.equal(rotationEnabled({ XKIRO_KEY_ROTATION: "0" }), false);
  assert.equal(rotationEnabled({ XKIRO_KEY_ROTATION: " off " }), false);
  assert.equal(rotationEnabled({ XKIRO_KEY_ROTATION: "on" }), true);
});

test("pool: env list is the source of truth and order is preserved", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` });
  assert.deepEqual(keys.all(), [K1, K2]);
  assert.equal(keys.available()[0], K1);
});

test("pool: a single key behaves exactly like no pool at all", () => {
  const { pool: keys } = pool({ XKIRO_API_KEY: `  ${K1}  ` });
  assert.deepEqual(keys.all(), [K1]);
  assert.equal(keys.pick("session-a"), K1);
  assert.equal(keys.pick("session-b"), K1);
});

test("pool: sessions stay pinned to one account, different sessions spread", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2},${K3}` });
  const first = keys.pick("session-a");
  assert.equal(first, K1);
  for (let turn = 0; turn < 5; turn++) assert.equal(keys.pick("session-a"), first, "prompt cache affinity needs a stable account");
  assert.equal(keys.pick("session-b"), K2);
  assert.equal(keys.pick("session-c"), K3);
  assert.equal(keys.pinned("session-a"), first);
});

test("pool: rotation off pins everything to the first key", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}`, XKIRO_KEY_ROTATION: "off" });
  assert.equal(keys.pick("a"), K1);
  assert.equal(keys.pick("b"), K1);
});

test("pool: exclude moves a retried request to another account", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` });
  assert.equal(keys.pick("s", []), K1);
  assert.equal(keys.pick("s", [K1]), K2);
  assert.equal(keys.pick("s", [K1, K2]), undefined, "nothing left to try");
});

test("pool: quota, rate and auth failures park the key for different lengths", () => {
  const time = clock();
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` }, time);
  keys.pick("s");
  keys.reportFailure(K1, "quota");
  assert.equal(keys.pick("s"), K2, "the session re-picks away from a parked key");
  assert.equal(keys.pinned("s"), K2);
  assert.deepEqual(
    keys.status().map((entry) => [entry.label.endsWith(K1.slice(-4)), entry.coolingMs]),
    [
      [true, COOLDOWN_QUOTA_MS],
      [false, 0],
    ],
  );
  time.advance(COOLDOWN_QUOTA_MS);
  assert.ok(keys.available().includes(K1), "the park expires");

  keys.reportFailure(K2, "rate");
  assert.ok(keys.status().find((entry) => entry.label.endsWith(K2.slice(-4)))?.coolingMs === COOLDOWN_RATE_MS);
  keys.reportFailure(K1, "auth");
  assert.equal(keys.status().find((entry) => entry.label.endsWith(K1.slice(-4)))?.failures, 2, "one parked key counted twice");
  assert.ok(keys.status().find((entry) => entry.label.endsWith(K1.slice(-4)))!.coolingMs <= COOLDOWN_AUTH_MS);
});

test("pool: a success clears the park, and everything-parked still returns a key", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` });
  keys.reportFailure(K1, "quota");
  keys.reportFailure(K2, "quota");
  assert.deepEqual(keys.available().sort(), [K1, K2], "stale cooldowns must not lock pi out of a working gateway");
  keys.reportSuccess(K1);
  assert.equal(keys.status().find((entry) => entry.label.endsWith(K1.slice(-4)))?.coolingMs, 0);
});

test("pool: reset() clears pins and parks", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` });
  keys.pick("s");
  keys.reportFailure(K1, "auth");
  keys.reset();
  assert.equal(keys.status().every((entry) => entry.coolingMs === 0 && entry.failures === 0), true);
  assert.equal(keys.pinned("s"), undefined);
});

test("pool: credential keys join the pool without displacing the env list", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: K1 });
  keys.addCredentialKey(`  ${K2}  `);
  assert.deepEqual(keys.all(), [K1, K2]);
  keys.addCredentialKey(undefined);
  keys.addCredentialKey("   ");
  assert.deepEqual(keys.all(), [K1, K2]);
});

test("pool: file source is hot-reloaded on mtime change and survives a broken rewrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xkiro-keys-"));
  const path = join(dir, "keys.json");
  writeFileSync(path, JSON.stringify({ keys: [K1, K2] }), { mode: 0o600 });
  const time = clock();
  const warnings: string[] = [];
  const { pool: keys } = pool({ XKIRO_API_KEYS_FILE: path }, time, warnings);
  assert.deepEqual(keys.all(), [K1, K2]);

  writeFileSync(path, JSON.stringify({ keys: [K3] }), { mode: 0o600 });
  time.advance(10_000);
  assert.deepEqual(keys.all(), [K3]);

  writeFileSync(path, "{ not json", { mode: 0o600 });
  time.advance(10_000);
  assert.deepEqual(keys.all(), [K3], "a broken file must keep the previous pool");
  assert.equal(warnings.filter((line) => line.includes("not a usable key file")).length, 1, "warned once");

  assert.deepEqual(pool({ XKIRO_API_KEYS_FILE: join(dir, "absent.json") }, clock(), warnings).pool.all(), []);
  assert.equal(warnings.filter((line) => line.includes("does not exist")).length, 1);
});

test("status: labels only, never the key", () => {
  const { pool: keys } = pool({ XKIRO_API_KEYS: `${K1},${K2}` });
  const dump = JSON.stringify(keys.status());
  assert.ok(!dump.includes(K1.slice(0, 12)) && !dump.includes(K2.slice(0, 12)));
  assert.ok(dump.includes(fingerprint(K1)));
});

test("failureKindForStatus: the retryable set from the docs' status table", () => {
  assert.equal(failureKindForStatus(402), "quota");
  assert.equal(failureKindForStatus(429, "Too Many Requests"), "rate");
  assert.equal(failureKindForStatus(429, "daily free token limit reached"), "quota");
  assert.equal(failureKindForStatus(401), "auth");
  assert.equal(failureKindForStatus(503), "transient");
  assert.equal(failureKindForStatus(529), "transient");
  assert.equal(failureKindForStatus(400), undefined, "a 400 never becomes someone else's fault");
  assert.equal(failureKindForStatus(403), undefined, "tier gating is not a capacity signal");
  assert.equal(failureKindForStatus(404), undefined);
  assert.equal(failureKindForStatus(undefined), undefined);
});

test("failureKindForMessage: status-less classification stays conservative", () => {
  assert.equal(failureKindForMessage("insufficient_quota: top up your wallet"), "quota");
  assert.equal(failureKindForMessage("429 Too Many Requests"), "rate");
  assert.equal(failureKindForMessage("Invalid or disabled ClientApiKey."), "auth");
  assert.equal(failureKindForMessage("502 Bad Gateway"), "transient");
  assert.equal(failureKindForMessage('Model "nope/fake-9000" does not exist.'), undefined);
  assert.equal(failureKindForMessage("requires an active paid plan or real deposited balance"), undefined);
  assert.equal(failureKindForMessage(""), undefined);
});
