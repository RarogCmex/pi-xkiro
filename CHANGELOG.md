# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

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
