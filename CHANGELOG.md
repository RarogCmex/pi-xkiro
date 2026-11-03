# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

## [0.2.0] — 2026-11-03

**Two memories instead of one: what the gateway refused, and what it is not
handing out right now.** Driven by measurement, not by speculation.

**Verified against pi 1.5.0 (2026-11-03):** `npm run check` clean, **101/101**
offline tests green (87 committed + 14 new).

### A 403 is a fact about the account-to-model relation

- **`reportTierDenial` / `learnedTiers` / `refusedBy`** (`discovery.ts`): the
  gateway's own `403 permission_denied` now corrects the listing's
  `access_tier`. `tierOf` reads through the correction, so every existing
  consumer — the pre-flight gate, `filterModels`, `gatedMessage`, `/xkiro` —
  sees it without knowing it exists. The correction only escalates
  (`free → paid → premium`).
- **Per-account, not pool-wide**: `refusedBy` records the accounts that were
  actually refused, by key fingerprint. A refusal by an account whose
  entitlement already covered the tier contradicts the listing, so the
  accounts that were NOT refused stay on offer; a refusal by an account that
  lacked the tier merely confirms it, and then `blocked` is the honest answer.
- **`filterModels` hides a learned refusal unconditionally**, including under
  an explicit `XKIRO_TIERS` — that variable overrides tier *inference*, and a
  403 is not inference — but only for a credential that is in the pool. A key
  we never measured must not lose models on the pool's evidence.
- **`/xkiro reset`** clears the learned tiers and refusals alongside the pool.

### A 503/429 is a fact about the minute

- **`isModelUnavailable`** (`errors.ts`) recognises exactly two forms: `503`
  with `temporarily unavailable` / `due to high demand` / `service_unavailable`,
  and `429` carrying `rate_limit_exceeded` — never a `429` that is daily-quota
  exhaustion, which is the account's fault and has its own rewrite. A bare
  `503 Service Unavailable` from a CDN and a `400` with capacity wording are
  both refused as evidence.
- **`unavailableUntil` / `isModelUnavailableNow` / `unavailableModels`**
  (`discovery.ts`): the mark expires on its own — 15 minutes for a `503`,
  5 minutes for a `429` — because a drained model comes back. A second refusal
  restarts the clock. `clearUnavailable()` is wired into `/xkiro reset`.
- **Pre-flight refusal** (`provider.ts`): while the mark is live the request
  does not leave, and `unavailableMessage` says why, for how long, and that
  another key would change nothing.
- **`clarifyUnavailableError`** joins the rewrite chain behind overflow, tier
  and quota: the gateway's status and body are kept verbatim, the text says
  "not your key, not your balance, another key gives the same answer".
- **`/xkiro models`** prints the marked ids with the seconds they have left.

### Measurement behind it

All 45 `free` ids were probed live on 2026-11-03 (two passes): 26 answered
`200`, 12 answered `429 rate_limit_exceeded`, 7 answered `503 service_unavailable`
— every failing id was `qwen/*:free`, on four accounts whose `GET /v1/usage`
still reported ~930k of the daily free tokens. Hence "the model is out", not
"you are out". The full table is in README § «Проба всех free-моделей».

### Test isolation

`clearLearnedDenials()` is now called by the rotation test that follows the
tier-refusal tests: a learned refusal deliberately reorders the keys, and that
ordering leaked into an unrelated assertion.

## [0.1.3] — 2026-11-03

**Re-verified against pi 1.5.0** (2026-11-03): `tsc -p tsconfig.json` clean, the
committed offline suite **87/87** green, offline boot unchanged. This release
carries no provider-behaviour change: it is the 1.5.0 host migration plus the first
`CHANGELOG.md` (`pi.changelogPath` is not set — the file is at the package root).

- **Adopted — the package changelog.** pi 1.5.0 reads `<package>/CHANGELOG.md`
  and shows entries newer than the version it last saw on the first fresh launch;
  a git package only moves when `version` grows, hence the patch bump.
- **No code break this time.** pi-ai 1.5.0 stopped re-exporting TypeBox, but this
  package never imported `Type` from pi-ai — typecheck is clean against the
  linked 1.5.0 packages.
- **Not adopted from 1.5.0, deliberately.** This package registers no tools, so
  the pi-schema validation/coercion contract does not apply; there is no custom
  tool renderer (`keyHint()`/`keyText()`), no `ctx.ui.custom()` (`blocked`), and
  `pi.exec()` is never called (`maxBuffer`/`truncated`). `Usage.cost.totalFromProvider`
  and `responseModel` are filled by the host runtime. GPT-6.1 Terra, models.dev v2
  and the changed defaults are host catalogs; this package's cards come from its
  own live listing. MCP OAuth client registration does not apply.
- **Working tree note.** The migration was applied on top of an uncommitted
  "learned 403" experiment (six files, not part of this release). It is coherent
  but its own suite is not green: 96 tests collected, 94 pass, 2 fail
  (`selectKeysForTier: a learned refusal outranks the entitlement`,
  `filterModels: a learned refusal hides the id, even under an explicit
  XKIRO_TIERS`). The committed tree is 87/87.

## [0.1.2] — 2026-10-22

Re-verified on pi 1.4.0 / pi-ai 1.4.0: typecheck clean on tsc 7.1.0-dev and
5.9.3, 87/87 offline tests green, and the extension loaded in a real pi 1.4.0
process printing the free-tier catalog. No provider-surface change; the live
matrix was not re-run (it spends the daily free quota).

## [0.1.1] — 2026-10-06

Re-verified on pi 1.0.4: 87/87 offline tests green; offline `--list-models`
unchanged.

## [0.1.0] — 2026-09-24

Initial release: the xKiro provider — a live catalog with per-model reasoning
levels, entitlement-aware free/paid/premium registration, and a multi-account key
pool for the daily free quota; paid models on a free-only account are refused
before the network. The same round added the README's free-tier matrix, dropped
the real wallet balance and account inventory from the tree, named the env-key
constant, fixed the `QUOTA_RE` typo and a dead re-export, then added the MIT
license, publish metadata, the self-contained docs, the offline CI suite, the
`engines.node` 22.19.0 floor and the pi 1.0.0 re-verification record.
