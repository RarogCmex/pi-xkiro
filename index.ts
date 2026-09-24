/**
 * xKiro provider for pi (https://api.xkiro.com/v1).
 *
 * Registers `xkiro` as a first-class pi-ai provider: OpenAI Chat Completions
 * against a live, fully self-describing catalog (`GET /v1/models` publishes
 * prices in USD, context/output caps, vision/tools/reasoning capabilities and
 * the exact `reasoning_effort` levels per model), account-entitlement aware
 * registration (`access_tier` × `GET /v1/usage`: a zero-balance account gets
 * the free tier, a topped-up one gets the rest), a key pool that spreads
 * sessions across accounts because xKiro meters its free tier per account
 * (500k–1M tokens/day each), a `/login` that reports what the entered key
 * actually unlocks, and readable rewrites for the gateway's tier-gating, quota
 * and non-standard context-overflow rejections.
 *
 * Verified against the live gateway on 2026-09-24 — README "Проверено руками"
 * holds the probe table (37/37 free models answering tool calls, the
 * `max_completion_tokens` cap ignored by `sensenova/*`, the 95-second blocking
 * cap that makes streaming mandatory, `reasoning_content` deltas, the
 * usage-only SSE frame, the 403/429/402/503 shapes, and the five keys on five
 * accounts with independent daily quotas).
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, which
// re-exports the protocol adapters (`openAICompletionsApi`). Subpaths other
// than /compat, /oauth and /providers/all are NOT aliased. tsconfig.json
// mirrors the alias so `npm run typecheck` sees what pi sees. This is the only
// pi-runtime-only module boundary in the package (same contract as
// pi-modelverse / pi-siliconflow).
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fetchListing,
  knownTiers,
  prefetchEntitlements,
  probeEntitlement,
  registerTiers,
  startupCatalog,
} from "./discovery.ts";
import { clarifyError } from "./errors.ts";
import { API_KEY_ENV_VAR, PROVIDER_ID, resolveBaseUrl, resolveTiers } from "./models.ts";
import { parseInlineKeys } from "./keys.ts";
import { balancePool, buildXkiroProvider, createPool, describeEntitlement, type XkiroApis } from "./provider.ts";
import { fingerprint } from "./keys.ts";

/** Key usable before pi has resolved any credential: the env sources only. */
function startupKey(env: Record<string, string | undefined>): string | undefined {
  return parseInlineKeys(env["XKIRO_API_KEYS"])[0] ?? env[API_KEY_ENV_VAR]?.trim() ?? undefined;
}

/** How long startup may wait for the live catalog. The listing is public and
 *  fast (~300 ms measured); beyond this the bundled snapshot is used. */
export const STARTUP_CATALOG_TIMEOUT_MS = 4_000;

export default async function (pi: ExtensionAPI) {
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
  const baseUrl = resolveBaseUrl();
  const pool = createPool(env);

  // pi waits for an async extension factory before it selects a model, so this
  // is what makes a widened `XKIRO_TIERS` (and the live prices/caps) visible
  // to `pi --list-models` and `--model` on the very first run. Failure is not
  // an option here: `undefined` falls back to the bundled snapshot.
  // Measure every account in the pool once, up front. This single round of
  // `GET /v1/usage` is what makes three later things possible without another
  // request: the tier gate refusing paid models on a free-only account,
  // `filterModels` hiding them from /model, and balancing sessions by the free
  // quota each account has left.
  const keys = pool.all();
  if (keys.length > 0) {
    await prefetchEntitlements(baseUrl, keys, STARTUP_CATALOG_TIMEOUT_MS);
    if (keys.length > 1) balancePool(pool, baseUrl);
  }

  const initialEntries = await startupCatalog(
    baseUrl,
    startupKey(env),
    resolveTiers(),
    STARTUP_CATALOG_TIMEOUT_MS,
  );

  // Every xKiro failure the user can see goes through here. The gateway's own
  // wording is accurate but not actionable from inside pi: "exceeds the safe
  // limit of N tokens" does not trigger auto-compaction until pi recognizes it
  // as `context_length_exceeded`, and "requires an active paid plan or real
  // deposited balance" reads like a broken key when it is a tier gate.
  // Error-stop-guarded and provider-scoped, in the siblings' order.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const clarified = clarifyError(message.errorMessage ?? "");
    if (!clarified || clarified === message.errorMessage) return;
    return { message: { ...message, errorMessage: clarified } };
  });

  const api: XkiroApis = { "openai-completions": openAICompletionsApi() };
  pi.registerProvider(buildXkiroProvider(api, { pool, baseUrl, initialEntries }));

  /**
   * `/xkiro` — which key unlocks what and how much free quota is left today.
   * `/xkiro models` — catalog counts by tier. `/xkiro reset` — forget sticky
   * session pinning and cooldowns.
   */
  pi.registerCommand("xkiro", {
    description: "Ключи xKiro: аккаунты, открытые уровни, остаток бесплатной квоты",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "reset") {
        pool.reset();
        ctx.ui.notify("xkiro: пул сброшен — закрепления сессий за ключами и остывание сняты.", "info");
        return;
      }

      if (sub === "models") {
        const rows = knownTiers();
        const byTier = new Map<string, number>();
        for (const row of rows) byTier.set(row.tier, (byTier.get(row.tier) ?? 0) + 1);
        const lines = [...byTier.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tier, count]) => `  ${tier}: ${count}`)
          .join("\n");
        ctx.ui.notify(
          `xkiro: каталог — ${rows.length} id (включая недоступные уровни):\n${lines}\n` +
            "Модели недоступного уровня скрыты из /model, пока ключ не получит депозит; XKIRO_TIERS=free,paid,premium показывает все.",
          "info",
        );
        return;
      }

      const keys = pool.all();
      if (keys.length === 0) {
        ctx.ui.notify(
          "xkiro: ключей нет. /login xkiro, либо XKIRO_API_KEY=sk-xt-…, либо XKIRO_API_KEYS=k1,k2,… — несколько аккаунтов дают несколько суточных бесплатных квот.",
          "warning",
        );
        return;
      }

      ctx.ui.notify(`xkiro: проверяю ${keys.length} ключ(ов) на ${baseUrl}…`, "info");
      const listing = await fetchListing(baseUrl, undefined, 8_000);
      registerTiers(listing);
      const lines: string[] = [];
      let totalRemaining = 0;
      for (const key of keys) {
        const entitlement = await probeEntitlement(baseUrl, key);
        const usable = listing.filter((entry) => entitlement.tiers.includes(entry.tier)).length;
        totalRemaining += entitlement.freeRemainingToday ?? 0;
        const cooling = pool.status().find((entry) => entry.label === fingerprint(key));
        lines.push(
          `  ${fingerprint(key)} ${entitlement.probed ? "" : "(не отвечал)"} · ` +
            describeEntitlement(entitlement, listing.length, usable) +
            (cooling && cooling.coolingMs > 0 ? ` · остывает ${Math.ceil(cooling.coolingMs / 1000)}с` : ""),
        );
      }
      ctx.ui.notify(
        `xkiro: ${keys.length} аккаунт(ов), суммарно бесплатно сегодня осталось ~${totalRemaining.toLocaleString("en-US")} токенов:\n` +
          lines.join("\n") +
          "\n  pi держит сессию на одном аккаунте (кэш промпта), разные сессии распределяются по разным.",
        "info",
      );
    },
  });
}
