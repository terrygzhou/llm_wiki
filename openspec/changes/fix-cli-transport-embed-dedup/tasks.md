# Tasks

## 1. Fix abort race in CLI transports

- [ ] 1.1 In `src/lib/claude-cli-transport.ts`, replace both post-`listen()` guards `if (aborted || finished) { cleanup(); return }` (currently ~L282 and ~L317) with `if (aborted || finished) { finishWith(onDone); return }`. Verify by inspecting both call sites and confirming the `abortListener` and the pre-`try` guard now share the same idempotent `finishWith` form.
- [ ] 1.2 Same change in `src/lib/codex-cli-transport.ts` (~L155 and ~L192). Verify both call sites.
- [ ] 1.3 Add or extend a test that asserts `completion` resolves and `onDone` is invoked exactly once when the abort signal fires between `listen()` resolution and the spawn invoke. Verify by running the transport test suite and the new test passes on both transports.

## 2. Parallelize `dedup_embedding.embedPages`

- [ ] 2.1 Export `createAsyncLimiter` (and the `AsyncLimiter` type) from `src/lib/embedding.ts`. Verify by a grep showing the `export` keyword on both lines.
- [ ] 2.2 Rewrite `embedPages` in `src/lib/dedup_embedding.ts` to schedule each page's `fetchEmbedding` through `createAsyncLimiter(cfg.concurrency)`, preserving input order by indexing into the results array. Verify by a test that asserts: (a) in-flight count never exceeds `cfg.concurrency`, (b) page i's result equals the i-th original page's embedding, (c) a single-page failure is recorded as `null` without dropping other pages.
- [ ] 2.3 Update the doc comment on `embedPages` so it no longer claims the loop is sequential.

## 3. Document embedding scoring tunables

- [ ] 3.1 In `src/lib/embedding.ts`, add a one-line comment above `Math.max(topK * 3, 30)` (line ~799) stating it is the candidate-fetch floor and that it is an intentional, tunable constant. Verify by reading the diff.
- [ ] 3.2 Add a matching comment above the `0.3` tail-blend weight (line ~823). Verify by reading the diff.

## 4. Verification

- [ ] 4.1 Run the full test suite covering `src/lib/__tests__/` for transports, `dedup_embedding`, and `embedding`. Verify all pass with no new failures.
- [ ] 4.2 Run `tsc --noEmit` (or the project's typecheck script) to confirm the new export in `embedding.ts` does not break the build.
