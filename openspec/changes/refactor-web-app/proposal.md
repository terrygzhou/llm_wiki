# Refactor the web app (src/)

## Why

The Vite/React frontend in `src/` has outgrown its early structure. Evidence from the current tree (354 TS files, ~76k lines in `src/lib` alone):

- **`src/lib` is a flat dump of 235 files.** ~40% of them are `*.test.ts` mixed in at the top level, with no domain grouping. New contributors cannot tell where ingest, embedding, chat, and graph logic live.
- **Two 3.8k–2k-line files dominate behavior:** `src/lib/ingest.ts` (3,806 lines) and `src/components/chat/chat-panel.tsx` (2,022 lines) plus `chat-message.tsx` (1,712 lines) and `graph-view.tsx` (1,796 lines). These are single points of complexity for bugs, review, and parallel work.
- **Stores are growing but unbounded.** `wiki-store.ts` is 701 lines and mixes three concerns: file tree state, selection state, and ingest status. No documented boundary between stores.
- **No test colocating or grouping** — tests live in the same flat directory as implementation, making `src/lib` visually 1.8× bigger than it is.
- **Accessibility:** the app ships with Tauri's native chrome but the web shell has no documented a11y baseline (focus management, keyboard nav, ARIA roles on the chat panel, knowledge tree, and settings tabs).
- **No performance budget** — no bundle-size gate, no lazy loading of the major views (chat, graph, settings sections), no documented render-efficiency expectations.

This change does **not** rewrite the app. It restructures `src/` so the codebase can absorb the next six months of feature work without regressing readability, and sets measurable quality bars (testability, a11y, performance) that future PRs must respect.

## What Changes

- **Reorganize `src/lib` by domain.** Introduce domain folders `ingest/`, `embed/`, `chat/`, `graph/`, `i18n-support/`, `tauri/`, `utils/`, and colocate each `*.test.ts` next to its subject file. Delete the flat-file legacy layout; keep only genuinely cross-cutting modules at the top.
- **Split `ingest.ts`.** Extract `ingest/prompt.ts`, `ingest/parse.ts`, `ingest/commit.ts`, `ingest/queue.ts` (the `ingest-queue.ts` file is already factored out — fold it in), and an `ingest/index.ts` barrel that re-exports the public API. `ingest/index.ts` becomes the only public surface; the remaining top-level `ingest.ts` either disappears or becomes a thin re-export shim during migration.
- **Split `chat-panel.tsx` and `chat-message.tsx`.** Extract message rendering primitives into `chat/message/*`, input composition into `chat/input/*`, and panel orchestration (which currently drives scroll management, auto-focus, and message grouping) into `chat/panel/*`. Keep `chat-panel.tsx` a thin composition component.
- **Define store boundaries.** Split `wiki-store.ts` into `wiki/files-store.ts`, `wiki/selection-store.ts`, and `wiki/ingest-status-store.ts`. Add a short `docs/stores.md` contract: each store's public API, who owns which domain, and the rule "a store must not reach into another store's internals — compose at the component level".
- **Set a performance baseline.** Introduce a bundle-size budget check (Vite `rollup-plugin-visualizer` + `size-limit` or `vite-bundle-visualizer` gate) and lazy-load the settings sections, the graph view, and the chat panel's heavy dependencies (mermaid rendering, markdown renderer) via `React.lazy`.
- **Set an a11y baseline.** Document and implement: focus management for the chat panel's message list, keyboard navigation for the knowledge tree, `role="tablist"` / `aria-selected` on the settings tabs, `aria-live="polite"` for the chat stream, and a `webapp-testing` Playwright a11y pass that blocks merges on new violations.
- **TypeScript hygiene.** Remove the remaining `: any` in `src/stores` and `src/components/chat`, replace with explicit types from `src/types/wiki.ts` or a new `src/types/` module. Add a `noImplicitAny`-compatible lint rule (`@typescript-eslint/no-explicit-any` as warn, escalating to error in `src/components`).
- **Testability.** Add `src/test-helpers/fixtures/` (mock projects, mock LLM responses, mock Tauri command results) so store and component tests stop constructing ad-hoc fixtures inline. Introduce a `createTestTransport` helper that mimics `claude-cli-transport`'s stream shape, so chat tests can assert against stream semantics.

No public API changes: the Tauri command surface, the API server surface (`api_server.rs`), and the mcp-server surface are all out of scope. This is a frontend-internal restructure.

## Capabilities

### New Capabilities

- `web-app-structure`: the frontend is organized by domain (ingest, embed, chat, graph, tauri, i18n, utils), with each `*.test.ts` colocated next to its subject, and `src/lib/ingest` exposed only through a barrel.
- `chat-component-boundaries`: `chat-panel.tsx` and `chat-message.tsx` are thin compositions over extracted sub-components (`chat/message/*`, `chat/input/*`, `chat/panel/*`), with no single chat file exceeding ~400 lines.
- `store-boundaries`: each store owns exactly one domain; the `wiki-store` split (`files`, `selection`, `ingest-status`) is documented in `docs/stores.md`.
- `frontend-performance-budget`: the app has a documented bundle-size budget and lazy-loads settings sections, the graph view, and heavy chat dependencies (mermaid, markdown).
- `frontend-accessibility-baseline`: the chat stream announces via `aria-live`, the knowledge tree is keyboard-navigable, settings tabs use `role="tablist"`, and a Playwright a11y gate blocks new violations.
- `frontend-type-hygiene`: no `: any` remains in `src/stores` and `src/components/chat`; `@typescript-eslint/no-explicit-any` is configured as warn globally and error in `src/components`.
- `frontend-testability`: shared test fixtures live under `src/test-helpers/fixtures/` and a `createTestTransport` helper mimics the CLI transport stream shape, so store and component tests stop constructing ad-hoc fixtures inline.

### Modified Capabilities

(none — this change is additive to the frontend and modifies no existing capability spec.)

## Impact

- `src/lib/*` — reorganized into domain folders; `ingest.ts` split into 4 submodules + barrel.
- `src/components/chat/*` — extracted sub-component folders; panel and message components become thin.
- `src/stores/wiki-store.ts` — split into 3 stores; `docs/stores.md` added.
- `src/test-helpers/fixtures/` and `createTestTransport` — new.
- `package.json` / `vite.config.ts` — new bundle-size gate, lazy imports.
- `tsconfig.app.json` / ESLint config — `no-explicit-any` rule, path aliases for domain folders.
- No changes to `src-tauri/`, `mcp-server/`, `extension/`, or the API server.

Out of scope: Tauri backend refactor, the API server's `block_on` pattern, and the mcp-server package.
