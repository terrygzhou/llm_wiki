# Design

## Context

See proposal.md for motivation. The refactor has six independent workstreams:

1. **`src/lib` is a flat dump of 235 files** with no domain grouping.
2. **`chat-panel.tsx` (2,022 lines) and `chat-message.tsx` (1,712 lines)** are monoliths that mix composition with rendering.
3. **`wiki-store.ts` (701 lines)** mixes file-tree, selection, and ingest status in one store.
4. **No bundle-size budget** and no lazy loading of heavy views.
5. **No documented a11y baseline** for the chat stream, knowledge tree, or settings tabs.
6. **`: any` remains in `src/stores` and `src/components/chat`**, and test fixtures are scattered.

Each workstream is independently reviewable and mergeable. The design below picks the structural shape for each, and the milestones in `tasks.md` order them to keep every PR under ~20 files touched.

## Goals / Non-Goals

**Goals:**
- Restructure `src/lib` into domain folders with colocated tests.
- Split `ingest.ts`, `chat-panel.tsx`, and `chat-message.tsx` into sub-modules under a 400-line ceiling.
- Split `wiki-store.ts` into three domain stores with a documented contract.
- Add a documented bundle-size budget and lazy-load heavy views.
- Document and enforce an a11y baseline (aria-live on the chat stream, keyboard on the tree, `role="tablist"` on settings, Playwright axe gate).
- Remove `: any` from `src/stores` and `src/components/chat`; add shared test fixtures and a `createTestTransport` helper.

**Non-Goals:**
- No changes to `src-tauri/`, `mcp-server/`, `extension/`, or the API server surface.
- No rewrite of the Tauri command protocol, the LLM transport protocol, or the embedding model.
- No change to runtime behavior: the refactor is structural. The only permitted behavioral change is the lazy-loading of heavy views (which is an observably better user experience, not a feature change).

## Decisions

### Decision 1: `src/lib` becomes domain folders, not a monorepo of packages

**Chosen:** Reorganize `src/lib` into top-level domain folders (`ingest/`, `embed/`, `chat/`, `graph/`, `i18n-support/`, `tauri/`, `utils/`). Each folder owns its modules; cross-domain imports go through the owning folder's `index.ts` barrel. Tests colocate next to their subject (`<name>.test.ts`).

**Why:** A flat 235-file directory has no discoverability. Domain folders make the owner-of-X question unanswerable by layout. Barrels give a single import surface per domain, which is what the `import/no-restricted-paths` lint rule can enforce.

**Alternative considered:** Split `src/lib` into an `npm` workspace (e.g. `packages/lib-ingest`). Rejected: the app is a single Vite entry; workspace packages add build complexity without any runtime benefit. Barrels + path aliases give the same import discipline at lower cost.

### Decision 2: `ingest.ts` splits into four submodules plus a barrel

**Chosen:** Split `src/lib/ingest.ts` (3,806 lines) into:
- `ingest/prompt.ts` — prompt construction (the ~600-line `buildIngestPrompt` block).
- `ingest/parse.ts` — response parsing and validation.
- `ingest/commit.ts` — write-to-disk and state-commit logic.
- `ingest/queue.ts` — the existing `ingest-queue.ts` content (1,194 lines) folded in.
- `ingest/index.ts` — the only public surface; re-exports the four submodules' public API.

**Why:** The current `ingest.ts` is a god module that couples prompt construction, LLM response parsing, file writes, and queueing. Each concern has a different failure mode and a different test surface; splitting makes each independently testable.

**Alternative considered:** Split into more files (one per function). Rejected: 4 is the minimum that removes the god-module smell without creating a file-per-function microstructure that fights the colocated-test rule.

### Decision 3: `chat-panel.tsx` and `chat-message.tsx` split into sub-components

**Chosen:** Introduce `src/components/chat/message/`, `src/components/chat/input/`, `src/components/chat/panel/`. `chat-panel.tsx` becomes a thin composition (~300 lines) that imports from the three sub-folders. `chat-message.tsx` becomes a dispatcher (~250 lines) that delegates to `message/*` block renderers. No chat file exceeds 400 lines.

**Why:** The 2k-line panel mixes scroll management, auto-focus, message grouping, block rendering, and input composition. Splitting along the existing seams (block renderers, scroll hook, input composition) keeps the diff reviewable and keeps each sub-component testable in isolation.

**Alternative considered:** Move the chat domain into a `@llm-wiki/chat` package. Rejected: the package boundary is not needed; the folder boundary is enough to keep the diff reviewable.

### Decision 4: `wiki-store.ts` splits into three domain stores

**Chosen:** `wiki-store.ts` → `wiki-files-store.ts` + `wiki-selection-store.ts` + `wiki-ingest-status-store.ts`. A `docs/stores.md` file documents each store's public API and the rule that stores do not reach into each other's internals.

**Why:** The current store mixes three domains with different update frequencies (file tree changes on import, selection changes on click, ingest status changes during LLM calls). Splitting makes each store's update pattern predictable and lets a `useSyncExternalStore` consumer subscribe to the narrow slice it needs.

**Alternative considered:** Keep one store and add a `domain:` tag to each field. Rejected: the tag does not enforce the boundary; the file boundary does.

### Decision 5: Bundle budget is a `size-limit` block, not a custom CI script

**Chosen:** Add a `size-limit` block to `package.json` with per-chunk and total gzipped budgets. `vite build` runs `size-limit` as a post-build check. The budget file is a single JSON with the accepted numbers.

**Why:** `size-limit` is the de-facto standard for "bundle-size budget" checks in the Vite ecosystem; it has a one-line config and a one-line CI invocation. A custom script would be more flexible but more to maintain.

**Alternative considered:** `vite-bundle-visualizer` as a hard gate. Rejected: it is a visual tool, not a threshold tool. It complements `size-limit` but does not replace it.

### Decision 6: a11y baseline is documented + Playwright axe gate

**Chosen:** Add `docs/a11y.md` (the baseline) and a Playwright test (`tests/a11y/*.spec.ts`) that runs `@axe-core/playwright` on the chat panel, knowledge tree, and settings view. The gate fails CI on new violations relative to a recorded baseline.

**Why:** A documented baseline is what a reviewer can point at; the Playwright gate is what enforces it. Neither alone is enough.

**Alternative considered:** Lighthouse a11y score as a CI gate. Rejected: Lighthouse scores are flaky and coarse; axe is deterministic and fine-grained.

### Decision 7: `: any` is a warn globally, an error in `src/components`

**Chosen:** Configure `@typescript-eslint/no-explicit-any` as `warn` for the whole app and `error` for `src/components/`. Record the current `: any` count in `src/lib` as the baseline in `tasks.md`; the count must not increase.

**Why:** An immediate `error` everywhere would block the refactor merge (there are still `any` in `src/lib`). A `warn`-then-`error` escalation gives the refactor room to land without a hard gate, while the `error` gate on `src/components` forces the highest-signal code to be clean.

**Alternative considered:** Remove every `: any` in one PR. Rejected: that is a 100+ file diff; the escalation approach keeps the refactor mergeable and the cleanup a separate, reviewable PR.

## Risks / Trade-offs

- **Risk:** The `src/lib` reorg breaks path aliases in `tsconfig.app.json` and `vite.config.ts`. Mitigation: update the aliases in the same PR as the first `src/lib` domain folder (Decision 1, Milestone 1).
- **Risk:** The `ingest.ts` split changes the public import surface; existing callers of `src/lib/ingest` must be updated. Mitigation: the `index.ts` barrel re-exports the same API, so callers do not change.
- **Risk:** The `wiki-store` split changes the `useWikiStore` call sites. Mitigation: the old `wiki-store.ts` remains as a re-export shim for one PR; the next PR removes it.
- **Risk:** `size-limit` budgets set too tight cause CI noise. Mitigation: set the initial budget to the *current* build size, not an aspirational number; tighten in follow-up PRs.
- **Trade-off:** The a11y Playwright gate adds ~30 s to CI. Acceptable for a deterministic gate that blocks real violations.
- **Trade-off:** The `: any` escalation (warn globally, error in `src/components`) leaves `src/lib` with warnings until a follow-up PR. Accepted: the escalation is a documented path, not a permanent state.

## Migration Plan

Milestones in `tasks.md` are ordered so that each milestone is independently mergeable:

- **M1 (src/lib reorg):** create domain folders, move files, update aliases. Shims left in place.
- **M2 (ingest.ts split):** split into four submodules + barrel. Shims left in place.
- **M3 (chat component split):** split `chat-panel.tsx` and `chat-message.tsx`.
- **M4 (store split):** split `wiki-store.ts`; add `docs/stores.md`.
- **M5 (bundle budget):** add `size-limit` block; lazy-load heavy views.
- **M6 (a11y baseline):** add `docs/a11y.md` + Playwright axe gate.
- **M7 (type hygiene):** remove `: any` in `src/stores` and `src/components/chat`; add shared fixtures and `createTestTransport`.

Each milestone ends with a verification step from the matching spec's `## Verification` section.

## Open Questions

- **Bundle-size budget numbers.** The initial budget should be the *current* build size, not an aspirational number. The exact numbers are set in M5 by measuring the current build and writing them into `.size-limit.json`.
- **`createTestTransport` API shape.** The helper should emit the same event names and ordering as the real `claude-cli-transport`. The exact event sequence is determined by reading the real transport in M7.
- **a11y baseline file location.** `docs/a11y.md` is proposed; if the repo already has a `docs/` layout that disagrees, the baseline file goes there.
