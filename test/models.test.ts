/**
 * Listing parsing and the catalog row → pi `Model` conversion, including the
 * compat decisions that were made from probes rather than from the gateway's
 * "OpenAI-compatible" claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryToModel, parseListingEntry, resolveBaseUrl, resolveTiers, snapshotModels, CHAT_COMPAT, PROVIDER_ID, DEFAULT_BASE_URL } from "../models.ts";
import type { CatalogEntry } from "../catalog.ts";

const listing = JSON.parse(readFileSync(new URL("./fixtures/models-sample.json", import.meta.url), "utf8"));

function row(id: string): CatalogEntry {
  const entry = listing.data.find((candidate: { id?: string }) => candidate.id === id);
  const parsed = parseListingEntry(entry);
  assert.ok(parsed, `${id} must parse`);
  return parsed;
}

test("resolveBaseUrl: env override trimmed, trailing slashes stripped, gateway default else", () => {
  assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl(() => "https://mirror.example.com/v1//"), "https://mirror.example.com/v1//".replace(/\/+$/, ""));
  assert.equal(resolveBaseUrl(() => "  https://x.test/v1  "), "https://x.test/v1");
  assert.equal(DEFAULT_BASE_URL, "https://api.xkiro.com/v1", "the /v1 must stay: the adapter appends /chat/completions");
});

test("resolveTiers: auto by default, explicit list wins, junk falls back to auto", () => {
  assert.equal(resolveTiers(() => undefined), "auto");
  assert.equal(resolveTiers(() => " auto "), "auto");
  assert.deepEqual(resolveTiers(() => "free,paid"), ["free", "paid"]);
  assert.deepEqual(resolveTiers(() => "free,free,premium"), ["free", "premium"]);
  assert.equal(resolveTiers(() => "nonsense"), "auto");
});

test("parseListingEntry: real rows carry the published metadata", () => {
  const gpt = row("openai/gpt-5.6-sol");
  assert.equal(gpt.tier, "paid");
  assert.equal(gpt.vendor, "openai");
  assert.equal(gpt.name, "GPT-5.6 Sol");
  assert.equal(gpt.contextWindow, 1_000_000);
  assert.equal(gpt.maxTokens, 65_536);
  assert.deepEqual(gpt.input, ["text", "image"]);
  assert.equal(gpt.price.input, 5);
  assert.equal(gpt.price.output, 30);
  assert.equal(gpt.price.cacheRead, 0.5);
  assert.deepEqual(gpt.effort?.levels, ["low", "medium", "high", "xhigh", "max"]);
});

test("parseListingEntry: non-chat modalities and keyless junk are dropped", () => {
  assert.equal(parseListingEntry({ id: "voice-female", modality: "tts", access_tier: "paid" }), undefined);
  assert.equal(parseListingEntry({ id: "  " }), undefined);
  assert.equal(parseListingEntry({}), undefined);
  assert.equal(parseListingEntry(listing.data.find((entry: { id?: string }) => entry.id === undefined)), undefined);
});

test("parseListingEntry: missing metadata degrades instead of exploding", () => {
  const parsed = parseListingEntry({ id: "acme/new-model" })!;
  assert.equal(parsed.tier, "free", "an unlabelled new id is the only case where assuming free is the safe direction");
  assert.equal(parsed.name, "new-model", "falls back to the bare part after the vendor prefix");
  assert.equal(parsed.vendor, "acme");
  assert.equal(parsed.contextWindow, 32_768);
  assert.equal(parsed.maxTokens, 4_096);
  assert.deepEqual(parsed.input, ["text"], "vision must be published, not guessed");
  assert.equal(parsed.effort, null);
  assert.deepEqual(parsed.price, { input: 0, output: 0 });
});

test("parseListingEntry: malformed reasoning_efforts shapes normalize", () => {
  const effortOf = (raw: unknown) => parseListingEntry(raw as never)?.effort;
  assert.equal(effortOf({ id: "a/b", reasoning_efforts: { levels: [] } }), null);
  assert.equal(effortOf({ id: "a/b", reasoning_efforts: { levels: "high" } }), null);
  assert.equal(effortOf({ id: "a/b", reasoning_efforts: "x" }), null);
  assert.equal(effortOf({ id: "a/b", reasoning_efforts: null }), null);
  assert.deepEqual(
    effortOf({ id: "a/b", reasoning_efforts: { levels: ["low", "", 7, "high"], default: " " } }),
    { levels: ["low", "high"] },
  );
});

test("entryToModel: api, provider, base URL and the pinned compat", () => {
  const model = entryToModel(row("qwen/qwen3.8-max:free"), DEFAULT_BASE_URL);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, PROVIDER_ID);
  assert.equal(model.baseUrl, DEFAULT_BASE_URL);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 65_536);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.compat?.maxTokensField, CHAT_COMPAT.maxTokensField);
  assert.equal(model.compat?.supportsStore, false, "accepted but not shown to do anything: do not send");
  assert.equal(model.compat?.supportsStrictMode, false, "compatibility alone does not imply strict schema enforcement");
  assert.equal(model.compat?.thinkingFormat, "openai");
});

test("entryToModel: reasoning control, always-on reasoning, and non-reasoning are three different shapes", () => {
  const controlled = entryToModel(row("mistralai/mistral-small-2603"), DEFAULT_BASE_URL);
  assert.equal(controlled.reasoning, true);
  assert.equal(controlled.thinkingLevelMap?.off, "none");
  assert.equal(controlled.thinkingLevelMap?.high, "high");

  // qwen3.8-max reasons and streams reasoning_content but exposes no control.
  const always = entryToModel(row("qwen/qwen3.8-max:free"), DEFAULT_BASE_URL);
  assert.equal(always.reasoning, true);
  assert.deepEqual(always.thinkingLevelMap, { off: null });

  const plain = entryToModel(
    { ...row("qwen/qwen3.8-max:free"), reasoning: false, effort: null },
    DEFAULT_BASE_URL,
  );
  assert.equal(plain.reasoning, false);
  assert.equal(plain.thinkingLevelMap, undefined, "no thinking surface advertised at all");
});

test("entryToModel: gated tiers stay identifiable in the picker", () => {
  const paid = entryToModel(row("openai/gpt-5.6-sol"), DEFAULT_BASE_URL);
  assert.match(paid.name, /\[paid\]$/, "the model id stays exactly the gateway's id; the tier belongs to the name");
  assert.equal(paid.id, "openai/gpt-5.6-sol");
  const free = entryToModel(row("minimax/minimax-m3:free"), DEFAULT_BASE_URL);
  assert.equal(free.name, "MiniMax M3 (Free)");
});

test("entryToModel: the `:free` suffix survives verbatim", () => {
  for (const id of ["minimax/minimax-m3:free", "qwen/qwen3.8-max:free"]) {
    assert.equal(entryToModel(row(id), DEFAULT_BASE_URL).id, id, "the suffix IS the id on this gateway");
  }
});

test("snapshotModels: free baseline only, all usable, nothing gated leaks in", () => {
  const models = snapshotModels(["free"], DEFAULT_BASE_URL);
  assert.ok(models.length >= 30);
  assert.ok(models.every((model) => !/\[(paid|premium)\]$/.test(model.name)));
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
});
