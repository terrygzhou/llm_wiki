## Why

Code review of the CLI-transport and embedding pipeline found a real defect and several consistency gaps: in both CLI transports (`claude-cli-transport.ts`, `codex-cli-transport.ts`), the pre-spawn abort check after each `listen()` await calls a bare `cleanup()` that leaves the exported `completion` promise pending forever if an abort lands between listener registration and the spawn invoke. Separately, `dedup_embedding.embedPages` runs sequentially where its sibling `embedAllPages` already parallelizes, and two empirical tunables in `embedding.ts` scoring lack any documented rationale.

## What Changes

- **Fix the completion-promise abort race in both CLI transports.** The post-`listen()` checks `if (aborted || finished) { cleanup(); return }` in `src/lib/claude-cli-transport.ts` (L282, L317) and `src/lib/codex-cli-transport.ts` (L155, L192) must route through `finishWith(onDone)` instead of bare `cleanup()`, so that an abort landing between `listen()` and the spawn invoke still kills the child, invokes the caller's completion callback, and resolves the `completion` promise.
- **Parallelize `dedup_embedding.embedPages`.** Use the same `createAsyncLimiter(cfg.concurrency)` pattern that `embedAllPages` already uses, so a 5000-page corpus embeds in minutes instead of ~17 minutes.
- **Document the embedding scoring tunables.** Add code comments (or a `plans/` note) explaining the `Math.max(topK * 3, 30)` candidate floor at `embedding.ts:799` and the empirical `0.3` tail weight at `embedding.ts:823`, so they are recognized as intentional, tunable constants.

No breaking changes. The abort-race fix only changes the *failure* path: a previously hanging completion now settles.

## Capabilities

### New Capabilities

(none — this change modifies existing behavior only.)

### Modified Capabilities

- `cli-transport-termination`: aborts that land between listener registration and the spawn invoke must still kill the child process and settle the stream's `completion` promise (previously the promise leaked).
- `dedup-embedding-throughput`: `embedPages` must respect the configured embedding concurrency limit rather than running sequentially.
- `embedding-scoring-tunables`: the candidate floor and tail-blend weight used by vector search scoring must be documented in-code so future changes are intentional.

## Impact

- `src/lib/claude-cli-transport.ts` — 2 post-`listen()` checks
- `src/lib/codex-cli-transport.ts` — 2 post-`listen()` checks
- `src/lib/dedup_embedding.ts` — `embedPages` loop
- `src/lib/embedding.ts` — doc comments on tunable constants (no logic change)
- No API changes; no new dependencies.
