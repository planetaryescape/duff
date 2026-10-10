# Vendored anti-slop

Source: <https://github.com/dmmulroy/anti-slop>

Commit: [c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b](https://github.com/dmmulroy/anti-slop/commit/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b)

Upstream package version: 0.1.2. Imported into Duff on 2026-10-10 from the sibling foldkit-mde workspace, which recorded this upstream revision.

The complete canonical `src/`, its tests, README, TypeScript configuration, and MIT license are retained. The nested ESLint Stylistic license and provenance are retained unchanged.

Local adaptations:

- A private Bun workspace manifest replaces upstream's pnpm manifest and skill-maintenance scripts. It exposes the generic and Effect entrypoints.
- Tests run through a Bun package script, using Node's native TypeScript support instead of tsx. Oxlint RuleTester does not support Bun. Node 22.18+ is required. The spacing CLI integration test invokes `bun run oxlint` instead of `pnpm exec oxlint`.
- `@oxlint/plugins` is pinned to 1.87.0, matching root Oxlint exactly. Node declarations are a workspace development dependency; the compiler comes from root development dependencies.
- Root application lint/format rules exclude this upstream source. Its own tests run in `bun run test`; its independent TypeScript check runs in `bun run check`.
- Duff adds `src/duff.ts` and `src/duff.test.ts` to preserve named spans and the extension runtime boundary without ESLint. These are local additions, not upstream rules.

No production rule implementations were changed. Upstream's skills, agent guidance, workflows, synchronization scripts, and lockfile were not imported.

Refresh from an explicit upstream commit. Compare against this recorded revision and retain local adaptations and both licenses.
