# Tasks

## 1. Reorganize `src/lib` into domain folders (Milestone 1)

- [ ] 1.1 Create the seven domain folders under `src/lib/`: `ingest/`, `embed/`, `chat/`, `graph/`, `i18n-support/`, `tauri/`, `utils/`. Verify by `ls src/lib/` showing the seven new folders.
- [ ] 1.2 Move the relevant files into their owning folder. `ingest.ts`, `ingest-queue.ts`, and `ingest-progress.ts` → `ingest/`. `embedding.ts`, `dedup_embedding.ts`, and `embedding.test.ts` → `embed/`. `chat-*.ts` files → `chat/`. `graph-*.ts` files → `graph/`. `i18n*.ts` → `i18n-support/`. `tauri-*.ts` → `tauri/`. Remaining one-shot utilities → `utils/`. Verify by a `find src/lib -maxdepth 1 -name "*.ts"` listing that shows only the root-level `index.ts` and no stray domain files.
- [ ] 1.3 Add `index.ts` barrels at the root of each domain folder that re-export the public API of the domain. Verify by a `grep -rn "from \"@/lib" src/` showing every external import goes through a domain barrel.
- [ ] 1.4 Update `tsconfig.app.json` and `vite.config.ts` path aliases to point at the new folders. Verify by `tsc --noEmit` passing and `vite build` succeeding.
- [ ] 1.5 Leave a one-line shim in `src/lib/` that re-exports from each domain's `index.ts` for one release. Verify by reading the shims.

## 2. Split `ingest.ts` into four submodules (Milestone 2)

- [ ] 2.1 Create `src/lib/ingest/prompt.ts` containing the prompt-construction block (the `buildIngestPrompt` region, ~600 lines). Verify by the file being under 400 lines.
- [ ] 2.2 Create `src/lib/ingest/parse.ts` containing the response-parsing and validation logic. Verify by the file being under 400 lines.
- [ ] 2.3 Create `src/lib/ingest/commit.ts` containing the write-to-disk and state-commit logic. Verify by the file being under 400 lines.
- [ ] 2.4 Create `src/lib/ingest/queue.ts` containing the current `ingest-queue.ts` content (moved in from the root). Verify by the file being under 400 lines.
- [ ] 2.5 Create `src/lib/ingest/index.ts` that re-exports the public API of the four submodules. Verify by `grep -n "export" src/lib/ingest/index.ts` showing every public symbol is re-exported.
- [ ] 2.6 Remove the old `src/lib/ingest.ts` and `src/lib/ingest-queue.ts`. Verify by `ls src/lib/` showing the folder, not the files.

## 3. Split `chat-panel.tsx` and `chat-message.tsx` (Milestone 3)

- [ ] 3.1 Create `src/components/chat/message/` with one file per message-block renderer (code, image, tool call, citation, …). Each file is under 400 lines. Verify by `find src/components/chat/message -name "*.tsx" -exec wc -l {} \;` showing no file over 400.
- [ ] 3.2 Create `src/components/chat/input/` containing the input composition (textarea, send button, attach, …). Verify by the folder existing and the old input code being removed from `chat-panel.tsx`.
- [ ] 3.3 Create `src/components/chat/panel/` containing `use-message-list-scroll.ts` and any other panel-level hooks. Verify by the hooks being importable from `@/components/chat/panel`.
- [ ] 3.4 Rewrite `chat-panel.tsx` to a thin composition under 400 lines. Verify by `wc -l src/components/chat/chat-panel.tsx` under 400.
- [ ] 3.5 Rewrite `chat-message.tsx` to a dispatcher under 400 lines. Verify by `wc -l src/components/chat/chat-message.tsx` under 400.

## 4. Split `wiki-store.ts` into three domain stores (Milestone 4)

- [ ] 4.1 Create `src/stores/wiki-files-store.ts` (file tree, expanded nodes, selected file). Verify by the file containing only file-tree state.
- [ ] 4.2 Create `src/stores/wiki-selection-store.ts` (selection, pinned files, scroll position). Verify by the file containing only selection state.
- [ ] 4.3 Create `src/stores/wiki-ingest-status-store.ts` (in-flight ingest, last import error, import progress). Verify by the file containing only ingest-status state.
- [ ] 4.4 Migrate every `useWikiStore` call site to the new stores, one file at a time. Verify by `grep -rn "useWikiStore" src/` returning zero matches.
- [ ] 4.5 Leave `src/stores/wiki-store.ts` as a re-export shim for one release. Verify by the shim importing from the three new files.
- [ ] 4.6 Write `docs/stores.md` documenting each store's public API and the "no cross-store reach" rule. Verify by the file listing all three stores and their public symbols.

## 5. Add a bundle-size budget and lazy-load heavy views (Milestone 5)

- [ ] 5.1 Add a `size-limit` block to `package.json` with per-chunk and total gzipped budgets set to the *current* build size. Verify by running `npx size-limit` and seeing it pass at the recorded numbers.
- [ ] 5.2 Run `npm run build` and record the per-chunk and total sizes in `.size-limit.json`. Verify by the file listing the accepted numbers.
- [ ] 5.3 Add `React.lazy` for the graph view, the settings view, and the chat panel's heavy dependencies (mermaid renderer, markdown renderer) in `src/App.tsx`. Verify by `grep -n "lazy" src/App.tsx` showing at least three `lazy` imports.
- [ ] 5.4 Add a named `React.Suspense` fallback for each lazy chunk. Verify by `grep -n "Suspense" src/App.tsx` showing a named fallback per lazy import.
- [ ] 5.5 Add an error boundary per lazy chunk with a "retry" action. Verify by `grep -n "ComponentErrorBoundary\|ChunkError" src/App.tsx` showing a retry action.

## 6. Add an accessibility baseline and a Playwright axe gate (Milestone 6)

- [ ] 6.1 Add `aria-live="polite"` to the chat message list and wrap each message in `role="listitem"` inside a `role="list"` container. Verify by `grep -n "aria-live" src/components/chat/chat-panel.tsx` showing at least one match.
- [ ] 6.2 Add `role="tablist"` to the settings tab strip, `role="tab"` with `aria-selected` to each tab, and `role="tabpanel"` with `aria-labelledby` to the content area. Verify by `grep -n "role=\"tablist\"" src/components/settings/` showing at least one match.
- [ ] 6.3 Add keyboard navigation to `src/components/layout/knowledge-tree.tsx`: `ArrowUp`/`ArrowDown`, `ArrowRight`/`ArrowLeft`, `Enter`. Add `aria-expanded`, `role="tree"`, and `role="treeitem"` attributes. Verify by `grep -n "onKeyDown\|tabIndex\|role=\"tree" src/components/layout/knowledge-tree.tsx` showing at least three matches.
- [ ] 6.4 Write `docs/a11y.md` documenting the baseline (chat stream, knowledge tree, settings tabs). Verify by the file listing the three areas.
- [ ] 6.5 Add a Playwright a11y test (`tests/a11y/chat.spec.ts`, `tests/a11y/knowledge-tree.spec.ts`, `tests/a11y/settings.spec.ts`) that runs `@axe-core/playwright` on the three areas. Verify by `npx playwright test tests/a11y` passing on a clean tree and failing on an injected violation.
- [ ] 6.6 Record a baseline axe-report file (JSON) in `tests/a11y/baseline/` that the gate diffs against. Verify by the baseline file existing and the gate failing on new violations.

## 7. Type hygiene and shared test fixtures (Milestone 7)

- [ ] 7.1 Remove every `: any` in `src/stores/` (currently 4 occurrences in `wiki-store.ts`). Replace each with an explicit type from `src/types/wiki.ts` or a new type module. Verify by `grep -rn ": any" src/stores` returning zero matches.
- [ ] 7.2 Remove every `: any` in `src/components/chat/`. Verify by `grep -rn ": any" src/components/chat` returning zero matches.
- [ ] 7.3 Configure `@typescript-eslint/no-explicit-any` as `warn` globally and `error` in `src/components/`. Verify by `npx eslint src/components/` failing on a new `: any` and `npx eslint src/lib/` only warning on existing ones.
- [ ] 7.4 Record the current `: any` count in `src/lib/` as a baseline in `tasks.md` (this task) so the count can be tracked. Verify by the baseline number being recorded in the task description.
- [ ] 7.5 Create `src/test-helpers/fixtures/` with shared fixtures (`mock-project.ts`, `mock-tauri.ts`, `mock-llm-response.ts`). Verify by `ls src/test-helpers/fixtures/` showing at least three files.
- [ ] 7.6 Create `src/test-helpers/createTestTransport.ts` that emits the same event sequence as the real `claude-cli-transport`. Verify by a chat test using the helper to assert against a multi-message stream.
- [ ] 7.7 Migrate at least two existing tests to use the shared fixtures. Verify by `grep -rn "from \"@/test-helpers/fixtures" src/stores src/components` showing at least two import sites.

## 8. Verification

- [ ] 8.1 Run `npm test` (the full suite, including the new a11y Playwright tests). Verify all pass with no new failures.
- [ ] 8.2 Run `tsc --noEmit`. Verify it passes.
- [ ] 8.3 Run `npx eslint src/`. Verify zero `error`-level violations in `src/components/`; warnings in `src/lib/` are recorded but not blocking.
- [ ] 8.4 Run `npx size-limit`. Verify the budget passes.
- [ ] 8.5 Run `npx playwright test tests/a11y`. Verify the axe gate passes on a clean tree and fails on an injected violation.
- [ ] 8.6 Run `npx playwright test src/test-helpers/createTestTransport.test.ts`. Verify the transport helper emits the same event sequence as the real CLI transport.
