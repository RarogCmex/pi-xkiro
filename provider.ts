/**
 * Provider assembly: registration, `/login`, and the key-rotating transport.
 *
 * Split out from `index.ts` so it can be imported and exercised under plain
 * Node — everything here resolves through pi-ai's core entrypoint. The symbol
 * that lives only in the compat entrypoint (the OpenAI Completions adapter) is
 * injected by `index.ts` instead of imported here. Same contract as the
 * pi-modelverse / pi-siliconflow siblings.
 */

import {
  createAssistantMessageEventStream,
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type AssistantMessageEvent,
  type AuthInteraction,
  type Model,
  type Provider,
  type ProviderStreams,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  cachedEntitlement,
  fetchListing,
  fetchXkiroModels,
  probeEntitlement,
  registerTiers,
  tierOf,
  type Entitlement,
} from "./discovery.ts";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  PROVIDER_ID,
  PROVIDER_NAME,
  resolveBaseUrl,
  resolveTiers,
  snapshotModels,
  entryToModel,
  type XkiroApi,
  type XkiroModel,
} from "./models.ts";
import { TIERS_ENV_VAR } from "./models.ts";
import type { CatalogEntry } from "./catalog.ts";
import { failureKindForMessage, failureKindForStatus, XkiroKeyPool, type FailureKind } from "./keys.ts";

export const API_KEY_AUTH_NAME = `${PROVIDER_NAME} API key`;

/** The one surface registered; see models.ts for why the other two are not. */
export type XkiroApis = { "openai-completions": ProviderStreams };

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Share the pool with `/xkiro`. Omit to get a private one. */
  pool?: XkiroKeyPool;
  /**
   * Live catalog rows already fetched by the async extension factory. When
   * absent the provider registers the bundled free-tier snapshot and waits for
   * pi's own refresh to widen it.
   */
  initialEntries?: readonly CatalogEntry[];
}

/** Free-tier quota + account identity for one key. This is the "which key
 *  works with what" answer, and `GET /v1/usage` is the only place it exists. */
export function probeUsage(
  baseUrl: string,
  key: string,
  timeoutMs = 8_000,
  fetchImpl: typeof fetch = fetch,
): Promise<Entitlement> {
  return probeEntitlement(baseUrl, key, timeoutMs, fetchImpl);
}

/** Human-readable one-liner for a probe result, shared by `/login` and `/xkiro`. */
export function describeEntitlement(entitlement: Entitlement, total: number, usable: number): string {
  const quota =
    entitlement.freeLimitPerDay !== undefined
      ? `осталось ${(entitlement.freeRemainingToday ?? 0).toLocaleString("en-US")} из ${entitlement.freeLimitPerDay.toLocaleString("en-US")} бесплатных токенов сегодня`
      : "квота неизвестна";
  return (
    `${entitlement.email ?? "аккаунт неизвестен"} · уровни ${entitlement.tiers.join("+")} · ${quota} · ` +
    `моделей доступно ${usable}/${total}` +
    (entitlement.tiers.length === 1 ? " (нужен депозит для платных)" : "")
  );
}

/**
 * Stored-key-then-env auth (`/login` → `XKIRO_API_KEY`), with the xKiro twist:
 * the entered key is resolved against the gateway and what the login flow
 * reports back is the *account* — email, plan, wallet, remaining free tokens
 * for today, and therefore which tiers this key can actually run.
 *
 * On this gateway that is the whole key↔model mapping. Unlike Modelverse,
 * `GET /v1/models` returns the same 120 rows for every caller (docs,
 * /api/list-models/: "it is not filtered by account"); what differs per key is
 * entitlement and the daily free-token pool.
 */
export function xkiroApiKeyAuth(baseUrl: string, pool: XkiroKeyPool, fetchImpl: typeof fetch = fetch): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction: AuthInteraction) {
      interaction.signal?.throwIfAborted();
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "sk-xt-…",
      });
      interaction.signal?.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("sk-xt-")) {
        interaction.notify({
          type: "info",
          message: "xkiro: ключ у этого шлюза начинается с sk-xt- — сохраняем как есть, но проверьте опечатку.",
        });
      }

      const entitlement = await probeUsage(baseUrl, key, 8_000, fetchImpl);
      if (!entitlement.probed) {
        throw new Error(
          "xkiro: шлюз не принял ключ (GET /v1/usage ответил ошибкой или 401). Проверьте ключ на xkiro.com и повторите /login xkiro.",
        );
      }
      const listing = await fetchListing(baseUrl, key, 8_000, fetchImpl);
      registerTiers(listing);
      const usable = listing.filter((entry) => entitlement.tiers.includes(entry.tier)).length;
      interaction.notify({ type: "info", message: `xkiro: ${describeEntitlement(entitlement, listing.length, usable)}` });
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      if (resolved && key) {
        // Seed the pool with whatever pi resolved (auth.json or env) so a
        // single-key setup behaves exactly as it would without the pool.
        pool.addCredentialKey(key);
        return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
      }
      // A pool with no primary key is a supported setup: `XKIRO_API_KEYS=a,b` or
      // a key file, and no `XKIRO_API_KEY`. pi's own env lookup only knows the
      // single variable, so without this fallback it reports
      // “No API key found for xkiro” and never starts the model.
      const fromEnv = pool.envKeys()[0];
      if (!fromEnv) return undefined;
      return { auth: { apiKey: fromEnv }, source: "XKIRO_API_KEYS" };
    },
  };
}

/** Attempt cap for one logical request: every key gets one shot, then pi's own
 *  retry policy takes over. */
export const MAX_KEY_ATTEMPTS = 3;

/** Anything the user could already see. Retrying after this would duplicate
 *  output in the transcript, so only a failure before the first content event
 *  may move to another key. */
function isContentEvent(event: AssistantMessageEvent): boolean {
  return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

/** Minimal assistant message for an adapter that threw instead of yielding an
 *  `error` event (pi requires a terminal event on every stream). */
function syntheticError(model: Model<XkiroApi>, error: unknown): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason: "error",
    error: {
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
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

/**
 * Wrap the adapter so each request carries the pool's chosen key, and a
 * capacity failure on one account quietly moves to the next.
 *
 * `options.apiKey` is the credential pi resolved for the provider; the pool
 * may hold more (XKIRO_API_KEYS / key file). Selection therefore belongs to
 * this wrapper, not to auth. The HTTP status is captured through
 * `onResponse`, because the composed `errorMessage` pi shows the user is not
 * machine-readable enough to branch a retry on.
 */
export function withKeyRotation(
  api: ProviderStreams,
  pool: XkiroKeyPool,
  options?: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> },
): ProviderStreams {
  const maxAttempts = options?.maxAttempts ?? MAX_KEY_ATTEMPTS;
  const sleep = options?.sleep ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function pump<TOptions extends StreamOptions | SimpleStreamOptions>(
    mode: "stream" | "streamSimple",
    model: Model<XkiroApi>,
    context: TranscriptContext,
    incoming: TOptions | undefined,
    out: ReturnType<typeof createAssistantMessageEventStream>,
  ): Promise<void> {
    const tried: string[] = [];
    let emittedStart = false;
    // pi may hand us a key it resolved outside this pool (`--api-key`, a
    // models.json entry). Seed it so a single-key setup can never end up with
    // an empty pool and a hard error where a plain request would have worked.
    if (incoming?.apiKey) pool.addCredentialKey(incoming.apiKey, "request");

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = pool.pick(incoming?.sessionId, tried);
      if (!key) break;
      tried.push(key);

      const seen: { status?: number } = {};
      const perAttempt = {
        ...incoming,
        apiKey: key,
        onResponse: async (response: Parameters<NonNullable<TOptions["onResponse"]>>[0], respondedModel: unknown) => {
          seen.status = response.status;
          const existing = incoming?.onResponse;
          if (existing) await (existing as (r: unknown, m: unknown) => Promise<void>)(response, respondedModel);
        },
      } as TOptions;

      let contentForwarded = false;
      let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
      const inner =
        mode === "stream"
          ? api.stream(model, context, perAttempt as StreamOptions)
          : api.streamSimple(model, context, perAttempt as SimpleStreamOptions);
      try {
        for await (const event of inner) {
          if (event.type === "error") {
            errorEvent = event;
            break;
          }
          if (event.type === "start" && emittedStart) continue; // exactly one `start` per logical request
          if (isContentEvent(event)) contentForwarded = true;
          if (event.type === "start") emittedStart = true;
          out.push(event);
        }
      } catch (error) {
        errorEvent = syntheticError(model, error);
      }

      if (!errorEvent) {
        pool.reportSuccess(key);
        return;
      }

      const message = errorEvent.error.errorMessage ?? "";
      const kind: FailureKind | undefined =
        errorEvent.reason === "aborted"
          ? undefined
          : (failureKindForStatus(seen.status, message) ?? failureKindForMessage(message));

      if (!kind || contentForwarded || attempt === maxAttempts - 1) {
        if (kind) pool.reportFailure(key, kind);
        out.push(errorEvent);
        return;
      }
      pool.reportFailure(key, kind);
      if (kind === "transient" || kind === "rate") await sleep(250 * (attempt + 1));
    }

    // No usable key left (single-key setup with everything cooling, or the
    // pool is empty). Report it as an error rather than hanging the stream.
    out.push({
      type: "error",
      reason: "error",
      error: {
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
        stopReason: "error",
        errorMessage:
          "xkiro: нет ни одного доступного ключа (пул пуст или все ключи остужены после ошибок). " +
          "Проверьте /xkiro и XKIRO_API_KEYS.",
        timestamp: Date.now(),
      },
    });
  }

  const start = (
    mode: "stream" | "streamSimple",
    model: Model<XkiroApi>,
    context: TranscriptContext,
    incoming: StreamOptions | SimpleStreamOptions | undefined,
  ) => {
    const out = createAssistantMessageEventStream();
    void pump(mode, model, context, incoming, out).finally(() => out.end());
    return out;
  };

  return {
    stream: (model, context, streamOptions) => start("stream", model as Model<XkiroApi>, context, streamOptions),
    streamSimple: (model, context, streamOptions) =>
      start("streamSimple", model as Model<XkiroApi>, context, streamOptions),
  };
}

export function buildXkiroProvider(api: XkiroApis, build: BuildOptions = {}): Provider<XkiroApi> {
  const env = build.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {});
  const fetchImpl = build.fetchImpl ?? fetch;
  const baseUrl = build.baseUrl ?? resolveBaseUrl((name) => env[name]);
  const pool = build.pool ?? createPool(env);
  const tiers = resolveTiers((name) => env[name]);
  const staticModels: XkiroModel[] = build.initialEntries
    ? build.initialEntries.map((entry) => entryToModel(entry, baseUrl))
    : snapshotModels(tiers === "auto" ? ["free"] : tiers, baseUrl);

  const resolveKey = (context: RefreshModelsContext): string | undefined => {
    const stored = context.credential;
    if (stored?.type === "api_key" && typeof stored.key === "string" && stored.key.trim()) return stored.key.trim();
    const fromEnv = env[API_KEY_ENV_VAR]?.trim();
    if (fromEnv) return fromEnv;
    return pool.available()[0];
  };

  const provider = createProvider<XkiroApi>({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl,
    auth: { apiKey: xkiroApiKeyAuth(baseUrl, pool, fetchImpl) },
    models: staticModels,
    fetchModels: (context: RefreshModelsContext) =>
      fetchXkiroModels({ baseUrl, context, tiers, resolveKey, fetchImpl }),
    // Entitlement is per account and the account behind a credential is known
    // once `/login` or a refresh has probed it. Before that the full list stays
    // visible: a clarified 403 is a better failure than a model silently
    // vanishing from the picker.
    filterModels: (models, credential) => {
      const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
      const entitlement = key ? cachedEntitlement(key) : undefined;
      if (!entitlement) return models;
      const allowed = new Set(entitlement.tiers);
      return models.filter((model) => {
        const tier = tierOf(model.id);
        return tier === undefined || allowed.has(tier);
      });
    },
    api: { "openai-completions": withKeyRotation(api["openai-completions"], pool) },
  });
  return provider;
}

/** Relative difference in today's remaining quota within which accounts are
 * treated as equally good (see `balancePool`). */
export const BALANCE_BAND = 0.25;

/**
 * Order the pool by what each account has left today.
 *
 * Best effort and bounded: keys whose probe fails keep their configured
 * position (behind every key that answered), and a total failure leaves the
 * order untouched. Called from the async extension factory, so the cost is one
 * `GET /v1/usage` per key on startup — which is also what makes `/xkiro` and
 * `/login` able to print quota at all.
 */
export async function balancePool(
  pool: XkiroKeyPool,
  baseUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const keys = pool.all();
  if (keys.length < 2) return keys;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const measured = await Promise.all(
    keys.map(async (key) => {
      const entitlement = await probeEntitlement(baseUrl, key, timeoutMs, fetchImpl);
      return { key, remaining: entitlement.freeRemainingToday, probed: entitlement.probed };
    }),
  );
  const ranked = [...measured].sort((a, b) => {
    if (a.probed !== b.probed) return a.probed ? -1 : 1;
    return (b.remaining ?? -1) - (a.remaining ?? -1);
  });

  // Shuffle inside the "equally good" band. Concurrent pi processes probe
  // before any of them has spent anything, so a pure "most remaining first"
  // order would send every simultaneous start to the same account; a random
  // pick among accounts that are within BALANCE_BAND of the leader spreads
  // them without ever choosing a measurably emptier account.
  const top = ranked[0]?.remaining;
  const band: typeof ranked = [];
  const rest: typeof ranked = [];
  for (const entry of ranked) {
    const comparable =
      entry.probed &&
      entry.remaining !== undefined &&
      top !== undefined &&
      top > 0 &&
      entry.remaining >= top * (1 - BALANCE_BAND);
    (comparable ? band : rest).push(entry);
  }
  for (let i = band.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [band[i], band[j]] = [band[j] as (typeof band)[number], band[i] as (typeof band)[number]];
  }

  const ordered = [...band, ...rest].map((entry) => entry.key);
  pool.setPriority(ordered);
  return ordered;
}

/** The pool `/xkiro` reads and the transport writes. */
export function createPool(env: Record<string, string | undefined> = process.env): XkiroKeyPool {
  return new XkiroKeyPool({ env, onWarn: (message) => void console.warn(message) });
}

export { BASE_URL_ENV_VAR, TIERS_ENV_VAR };
