/**
 * Catalog data integrity: the shipped snapshot and the thinking-level
 * translation, which is the one piece of logic where a wrong table entry
 * turns into a wrong request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_TIER_SNAPSHOT,
  PI_LEVELS,
  SNAPSHOT_BY_ID,
  thinkingLevelMap,
  UNKNOWN_DEFAULTS,
  isTier,
} from "../catalog.ts";

test("snapshot: every id unique, free-tier, and shaped like a usable chat model", () => {
  assert.ok(FREE_TIER_SNAPSHOT.length >= 30, "expected the captured free tier to be present");
  const seen = new Set<string>();
  for (const entry of FREE_TIER_SNAPSHOT) {
    assert.ok(entry.id.trim().length > 0, "empty id");
    assert.ok(!seen.has(entry.id), `duplicate id ${entry.id}`);
    seen.add(entry.id);
    assert.equal(entry.tier, "free", `${entry.id} must be free-tier in the snapshot`);
    assert.ok(entry.id.includes("/"), `${entry.id} must carry the vendor prefix xKiro requires`);
    assert.ok(entry.name.trim().length > 0, `${entry.id} has no display name`);
    assert.ok(entry.contextWindow > 0 && entry.maxTokens > 0, `${entry.id} caps missing`);
    assert.ok(entry.contextWindow >= entry.maxTokens, `${entry.id}: output cap larger than the window`);
    assert.ok(entry.input.includes("text"), `${entry.id} must accept text`);
    assert.equal(entry.tools, true, `${entry.id}: the whole free tier was probed to answer tool calls`);
    assert.equal(isTier(entry.tier), true);
    // Free tier is priced at zero on this gateway; a non-zero snapshot row
    // would mean the capture picked up a paid id.
    assert.equal(entry.price.input, 0, `${entry.id} is not free`);
    assert.equal(entry.price.output, 0, `${entry.id} is not free`);
  }
});

test("snapshot: ids pi must resolve by identity, not by position", () => {
  for (const id of ["qwen/qwen3.8-max:free", "minimax/minimax-m3:free", "mistralai/mistral-small-2603"]) {
    assert.ok(SNAPSHOT_BY_ID.has(id), `${id} should stay in the snapshot: it is the coding-usable core of the free tier`);
  }
  assert.equal(SNAPSHOT_BY_ID.get("qwen/qwen3.8-max:free")?.contextWindow, 1_000_000);
});

test("thinkingLevelMap: absent control means no map at all", () => {
  assert.equal(thinkingLevelMap(null), undefined);
  assert.equal(thinkingLevelMap(undefined), undefined);
  assert.equal(thinkingLevelMap({ levels: [] }), undefined);
});

test("thinkingLevelMap: graded scale passes through and off maps to the model's own value", () => {
  const map = thinkingLevelMap({ levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], default: "high" })!;
  assert.equal(map.off, "none");
  for (const level of PI_LEVELS) assert.equal(map[level], level);
});

test("thinkingLevelMap: no off value means pi must not offer 'off'", () => {
  const map = thinkingLevelMap({ levels: ["low", "medium", "high", "xhigh", "max"] })!;
  assert.equal(map.off, null);
  assert.equal(map.max, "max");
});

test("thinkingLevelMap: two-position switches resolve every request to the on value", () => {
  // z-ai/glm-4.5 family: "A switch, not a dial" (docs /guides/reasoning/).
  for (const levels of [["off", "on"], ["adaptive", "disabled"], ["none", "high"]] as const) {
    const map = thinkingLevelMap({ levels: [...levels] })!;
    const positive = levels.filter((level) => level !== "off" && level !== "disabled" && level !== "none");
    for (const level of PI_LEVELS) assert.equal(map[level], positive[0], `${levels.join("+")} → ${level}`);
    assert.equal(map.off, levels.find((level) => level === "off" || level === "disabled" || level === "none"));
  }
});

test("thinkingLevelMap: requests above the scale step down, never up", () => {
  // Docs: "Above the model's range → step down to the nearest level it has."
  const map = thinkingLevelMap({ levels: ["low", "medium", "high"], default: "low" })!;
  assert.equal(map.high, "high");
  assert.equal(map.xhigh, "high");
  assert.equal(map.max, "high");
  assert.equal(map.minimal, "low", "below the floor falls back to the lowest positive level rather than being dropped server-side");
});

test("thinkingLevelMap: unknown vendor level names still rank as positive", () => {
  const map = thinkingLevelMap({ levels: ["none", "ultra"] })!;
  assert.equal(map.low, "ultra");
  assert.equal(map.off, "none");
});

test("unknown caps fall back conservatively, not optimistically", () => {
  assert.equal(UNKNOWN_DEFAULTS.contextWindow, 32_768);
  assert.ok(UNKNOWN_DEFAULTS.contextWindow < 200_000, "absent means unknown, never unlimited (docs /api/list-models/)");
});
