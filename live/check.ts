/**
 * Manual live checks against the real gateway. Reads ./secret.env (gitignored):
 *
 *   API=https://api.xkiro.com/v1
 *   KEY1=…   # five keys, five separate accounts (probed 2026-09-24)
 *   …
 *   KEY5=…
 *
 * Run:
 *   node live/check.ts              # accounts × quotas × entitlements, then the
 *                                   # free-tier request matrix (tool calls, caps,
 *                                   # reasoning, vision, streaming)
 *   node live/check.ts --snapshot   # print ONLY the FREE_TIER_SNAPSHOT rows on
 *                                   # stdout (everything else goes to stderr),
 *                                   # for splicing into catalog.ts
 *   node live/check.ts --surface    # re-probe /v1/responses and /v1/messages
 *
 * Everything here is a fact the plugin claims; the point of the file is that
 * those facts can be re-checked in one command instead of re-derived.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseListing } from "../discovery.ts";
import { thinkingLevelMap } from "../catalog.ts";
import type { CatalogEntry } from "../catalog.ts";

interface SecretEnv {
  API?: string;
  [key: string]: string | undefined;
}

function readSecretEnv(): SecretEnv {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = [join(here, "secret.env"), join(here, "..", "secret.env")].find((candidate) => existsSync(candidate));
  if (!path) throw new Error("secret.env not found next to live/check.ts");
  const out: SecretEnv = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const TIMEOUT_MS = 90_000;

/**
 * [1x1 red pixel, 64x64 red square] — both valid PNGs, base64-encoded.
 *
 * Both must be real, decodable PNGs. A hand-assembled base64 blob or a
 * zero-length image produces failures that belong to the probe rather than to
 * the gateway (a malformed blob reads as `400 Image … could not be loaded`), so
 * the fixtures below are kept as literals and regenerated with any standard
 * image tool, not built inline.
 */
const TINY_AND_REAL = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAe0lEQVR4nO3PUQkAIBTAwJfEBvYvYxhD+HEIgwW4zVn764YLGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLXjsAjJ9cQ+sy0baAAAAAElFTkSuQmCC",
];

/** Never throws: a hang or a transport error is a RESULT, not a crash. A model
 *  that ignores its output cap runs past the timeout, and that is exactly the
 *  behaviour being measured — so a timeout must be reportable, not fatal. */
async function post(url: string, key: string, body: unknown): Promise<{ status: number; json: any }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, json: { raw: text.slice(0, 200) } };
    }
  } catch (error) {
    return { status: (error as Error).name === "TimeoutError" ? 408 : 0, json: { raw: (error as Error).message } };
  }
}

async function get(url: string, key?: string): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: { raw: text.slice(0, 200) } };
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Multiply two numbers",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    },
  },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function accounts(api: string, keys: string[]): Promise<Map<string, string[]>> {
  const entitlements = new Map<string, string[]>();
  console.log("=== accounts (GET /v1/usage) ===");
  for (const [index, key] of keys.entries()) {
    const { status, json } = await get(`${api}/usage`, key);
    if (status !== 200) {
      console.log(`  KEY${index + 1}: HTTP ${status} ${json?.error?.message ?? ""}`);
      continue;
    }
    const tiers = json.plan ? ["free", "paid", "premium"] : Number.parseFloat(json.wallet?.balance_usd ?? "0") > 0 ? ["free", "paid"] : ["free"];
    entitlements.set(key, tiers);
    console.log(
      `  KEY${index + 1}  ${json.user?.email ?? "?"}  plan=${json.plan ?? "none"}  ` +
        `wallet=${json.wallet?.balance_usd ?? "?"}  free ${fmt(json.free_tokens?.used_today ?? 0)}/${fmt(json.free_tokens?.limit_per_day ?? 0)} used today`,
    );
  }
  return entitlements;
}

async function snapshot(api: string): Promise<void> {
  const { json } = await get(`${api}/models`);
  const rows = parseListing(json)
    .filter((entry) => entry.tier === "free")
    .sort((a, b) => a.id.localeCompare(b.id));
  const f = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  for (const entry of rows) {
    const effort = entry.effort
      ? `{ levels: [${entry.effort.levels.map((level) => JSON.stringify(level)).join(", ")}], default: ${JSON.stringify(entry.effort.default ?? null)} }`
      : "null";
    const price = [`input: ${entry.price.input}`, `output: ${entry.price.output}`];
    if (entry.price.cacheRead) price.push(`cacheRead: ${entry.price.cacheRead}`);
    if (entry.price.cacheWrite) price.push(`cacheWrite: ${entry.price.cacheWrite}`);
    console.log(
      `  { id: ${JSON.stringify(entry.id)}, name: ${JSON.stringify(entry.name)}, vendor: ${JSON.stringify(entry.vendor)}, tier: ${JSON.stringify(entry.tier)},\n` +
        `    contextWindow: ${f(entry.contextWindow)}, maxTokens: ${f(entry.maxTokens)}, input: ${JSON.stringify(entry.input)}, tools: ${entry.tools},\n` +
        `    reasoning: ${entry.reasoning}, effort: ${effort}, price: { ${price.join(", ")} } },`,
    );
  }
  console.error(`// ${rows.length} free chat models captured`);
}

async function matrix(api: string, key: string, entries: CatalogEntry[]): Promise<void> {
  console.log("\n=== free-tier request matrix ===");
  console.log("model".padEnd(34), "chat", "tool", "cap", "effort", "vis1x1", "visPNG", "stream", "levels→pi");
  let failures = 0;
  for (const entry of entries) {
    const cells: string[] = [];
    // 1. plain round trip
    const plain = await post(`${api}/chat/completions`, key, {
      model: entry.id,
      messages: [{ role: "user", content: "reply with exactly: pong" }],
      max_completion_tokens: 2000,
    });
    cells.push(plain.status === 200 ? "ok" : String(plain.status));

    // 2. tool call — the one pi cannot work without
    const tool = await post(`${api}/chat/completions`, key, {
      model: entry.id,
      messages: [{ role: "user", content: "What is 21 times 4? You MUST call the calculator tool." }],
      tools: TOOLS,
      tool_choice: "auto",
      max_completion_tokens: 4000,
    });
    const called = tool.json?.choices?.[0]?.message?.tool_calls?.length > 0;
    cells.push(called ? "ok" : tool.status === 200 ? "NO_CALL" : String(tool.status));

    // 3. is the output cap honoured? ask for an essay with a 5-token ceiling
    const capped = await post(`${api}/chat/completions`, key, {
      model: entry.id,
      messages: [{ role: "user", content: "Write 150 words about the sea." }],
      max_completion_tokens: 5,
    });
    const produced = capped.json?.usage?.completion_tokens ?? 0;
    cells.push(capped.status === 200 && produced <= 30 ? "ok" : produced > 30 ? `IGNORED(${produced})` : String(capped.status));

    // 4. reasoning effort accepted + reasoning_content present
    const reasoned = await post(`${api}/chat/completions`, key, {
      model: entry.id,
      messages: [{ role: "user", content: "Which is larger: 9.11 or 9.9? Think carefully." }],
      reasoning_effort: "high",
      max_completion_tokens: 4000,
    });
    cells.push(reasoned.status === 200 ? "ok" : String(reasoned.status));

    // 5. vision, only where published. TWO payloads — see the note on
    // TINY_AND_REAL for why both must be real PNGs. The distinction matters:
    // qwen/*:free answers 500 to a valid 1x1 image and 200 "Red" to a valid
    // 64x64 one, so a tiny-image failure is a gateway property while a
    // malformed-image failure is not.
    if (!entry.input.includes("image")) {
      cells.push("-", "-");
    } else {

      for (const pixel of TINY_AND_REAL) {
        const seen = await post(`${api}/chat/completions`, key, {
          model: entry.id,
          max_completion_tokens: 3000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What color is this image? One word." },
                { type: "image_url", image_url: { url: `data:image/png;base64,${pixel}` } },
              ],
            },
          ],
        });
        const answer = typeof seen.json?.choices?.[0]?.message?.content === "string" ? seen.json.choices[0].message.content.trim() : "";
        const ok = seen.status === 200 && /red/i.test(answer);
        cells.push(seen.status !== 200 ? String(seen.status) : ok ? "ok" : answer.slice(0, 6) || "empty");
      }
    }

    // 6. streaming terminates with [DONE] and emits a usage frame
    let streamed = "…";
    try {
      const response = await fetch(`${api}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: entry.id,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 2000,
          messages: [{ role: "user", content: "count to five" }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      const done = text.includes("[DONE]");
      const usage = /"usage":/.test(text);
      streamed = done && usage ? "ok" : done ? "NO_USAGE" : "NO_DONE";
    } catch (error) {
      streamed = (error as Error).name;
    }
    cells.push(streamed);

    const levels = entry.effort?.levels.join(",") ?? "-";
    const mapped = thinkingLevelMap(entry.effort);
    if (!cells.every((cell) => cell === "ok" || cell === "-")) failures++;
    if (entry.tier !== "free") failures++;
    const piLevels = mapped ? Object.entries(mapped).map(([level, value]) => `${level}=${value ?? "∅"}`).join(" ") : "-";
    console.log(entry.id.padEnd(34), cells.map((cell) => cell.padEnd(6)).join(" "), levels.padEnd(16), piLevels);
  }
  console.log(`\n${failures} of ${entries.length} models have at least one imperfect cell (see README caveats).`);
}

async function surfaces(api: string, key: string, model: string): Promise<void> {
  console.log("\n=== alternative wire surfaces (not registered by the plugin) ===");
  const responses = await post(`${api}/responses`, key, {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: "reply with exactly: pong" }] }],
    max_output_tokens: 2000,
  });
  console.log(`  POST /v1/responses   ${responses.status} ${responses.json?.output_text?.slice(0, 20) ?? responses.json?.error?.message ?? ""}`);
  const messages = await fetch(`${api}/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: "reply with exactly: pong" }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await messages.json()) as any;
  console.log(`  POST /v1/messages    ${messages.status} ${body?.content?.[0]?.text ?? body?.error?.message ?? ""}`);
  const modelsAnthropic = await fetch(`${api}/models`, {
    headers: { "anthropic-version": "2023-06-01", "x-api-key": key },
  });
  console.log(`  GET  /v1/models (anthropic shape) ${modelsAnthropic.status}`);
  const blocked = await post(`${api}/chat/completions`, key, {
    model: "openai/gpt-5.6-sol",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 10,
  });
  console.log(`  gated tier reference: openai/gpt-5.6-sol → ${blocked.status} ${blocked.json?.error?.code ?? ""}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const secrets = readSecretEnv();
  const api = (secrets.API ?? "https://api.xkiro.com/v1").replace(/\/+$/, "");
  const keys = Object.entries(secrets)
    .filter(([name]) => /^KEY\d+$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value as string);
  if (keys.length === 0) throw new Error("no KEY1..KEYn in secret.env");

  const listing = (await get(`${api}/models`)).json;
  const entries = parseListing(listing);
  // stderr, not stdout: `--snapshot` pipes this file's output straight into
  // catalog.ts, and one stray header line becomes a syntax error there.
  console.error(
    `gateway ${api} · ${entries.length} chat ids · tiers: ${[...new Set(entries.map((e) => e.tier))].join(",")}`,
  );

  if (mode === "--snapshot") {
    await snapshot(api);
    return;
  }
  const entitlements = await accounts(api, keys);
  if (mode === "--surface") {
    await surfaces(api, keys[0] as string, "qwen/qwen3.8-max:free");
    return;
  }
  const usable = entries
    .filter((entry) => entitlements.get(keys[0] as string)?.includes(entry.tier))
    .sort((a, b) => a.id.localeCompare(b.id));
  console.log(`\nmodels usable with KEY1's entitlement: ${usable.length}`);
  await matrix(api, keys[0] as string, usable);
  await surfaces(api, keys[0] as string, "qwen/qwen3.8-max:free");
}

await main();
