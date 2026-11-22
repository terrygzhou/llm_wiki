# Design

## Context

See proposal.md for motivation. Two separate concerns:

1. **Abort race in CLI transports.** Both `claude-cli-transport.ts` and `codex-cli-transport.ts` create a `completion` promise up front, wire a `finishWith(cb)` helper that marks `finished`, runs `cleanup()`, invokes `cb`, and resolves the promise. The abort listener already routes through `finishWith(onDone)`. But there are two post-`listen()` guards — one after the data listener, one after the done listener — that call a bare `cleanup(); return`. If the abort signal fires after one of those `await listen()` calls resolves but before the next `await` yields, the stream returns without ever calling `onDone` or resolving `completion`, leaving the caller hung. This was the "High" finding from the CLI transport/embedding review.

2. **Sequential `embedPages`.** `embedPages` in `dedup_embedding.ts` is a plain `for...of await` loop. Its sibling `embedAllPages` in `embedding.ts` already runs under `createAsyncLimiter(cfg.concurrency)`. The two functions live in different files; `dedup_embedding.ts` has not been ported to the limiter.

3. **Undocumented tunables.** `embedding.ts:799` uses `Math.max(topK * 3, 30)` as the candidate-fetch floor and `embedding.ts:823` uses `0.3` as the tail-blend weight. Both are intentional but neither has a comment that says why.

## Goals / Non-Goals

**Goals:**
- Kill the completion-promise leak on every abort timing in both transports.
- Bring `embedPages` to the same throughput class as `embedAllPages` without changing result order or error semantics.
- Document the two scoring constants so they are recognized as tunables.

**Non-Goals:**
- No change to the CLI protocol, the Rust spawn/kill side, or the public transport API.
- No change to embedding model, chunker, or similarity threshold.
- No change to the *value* of the scoring constants — only to their documentation.

## Decisions

### Decision 1: Route the two post-`listen()` guards through `finishWith(onDone)`, not `cleanup()`

**Chosen:** In both files, replace the two `if (aborted || finished) { cleanup(); return }` blocks with `if (aborted || finished) { finishWith(onDone); return }`.

**Why:** `finishWith` is idempotent (guarded by `finished`), it calls `cleanup()` internally, invokes the caller's `onDone` exactly once, and resolves `completion`. The existing pre-`try` guard already uses this form. The `abortListener` callback already uses it. Using the same form at the post-`listen()` sites makes the promise lifetime uniform.

**Alternative considered:** Add `resolveCompletion()` to the guard without invoking `onDone`. Rejected: the caller's `onDone` is what lets the ingest pipeline continue; silently resolving the promise while the caller's own callback never fires leaves the pipeline state inconsistent.

### Decision 2: Wrap `embedPages` with the existing `createAsyncLimiter`

**Chosen:** Export `createAsyncLimiter` and `AsyncLimiter` from `embedding.ts` (or re-export from a shared module), then in `dedup_embedding.ts` build the limiter with `cfg.concurrency` and rewrite the loop as:

```ts
const schedule = createAsyncLimiter(cfg.concurrency)
const jobs = pages.map(async (p) => {
  throwIfAborted(opts.signal)
  const text = pageToEmbeddingText(p, budget)
  const vec = await schedule(() => fetchEmbedding(text, cfg))
  throwIfAborted(opts.signal)
  return [p.id, vec] as const
})
const results = await Promise.all(jobs.map(schedule))
for (const [id, vec] of results) out.set(id, vec)
```

Result order is preserved by indexing into the `results` array (page i's result is the i-th entry), not by relying on `Promise.all` settling order.

**Why:** `createAsyncLimiter` is already the established pattern in this codebase (three call sites in `embedding.ts`). Reusing it means no new concurrency primitive, and the limiter's own backoff/error semantics match `embedAllPages`.

**Alternative considered:** Hand-roll a chunked map (`for (let i = 0; i < pages.length; i += N) await Promise.all(pages.slice(i, i+N).map(...))`). Rejected: the existing limiter handles both "at most N in flight" and "a finished slot admits a new job immediately", which a chunked map approximates worse; and a hand-rolled loop would diverge from the rest of the file.

### Decision 3: Document the two scoring constants in-place

**Chosen:** Add a short comment directly above each literal in `embedding.ts` (799 and 823), plus a one-line note in `plans/` if a `plans/` directory exists. The comment names the constant and explains it is intentionally empirical and safe to tune.

**Why:** No code change is needed. A code comment is the minimum-surprise place to make the value visible to whoever next touches the line.

**Alternative considered:** Extract to named constants at the top of the file. Deferred: this would be a mechanical refactor that touches two call sites and is only worth it if/when the values actually change.

## Risks / Trade-offs

- **Risk:** A caller of `embedPages` assumes strict sequential order (e.g. a caller that interleaves side effects between iterations). Mitigation: the only caller is `candidatePairs` in the same file, and its loop body is pure (map-then-embed); result order is preserved by `results[i]`.
- **Risk:** The limiter caps in-flight at `cfg.concurrency` which may be `undefined`. Mitigation: `createAsyncLimiter` already handles `undefined` (existing call sites rely on that).
- **Risk:** The transport fix could mask a second bug where `onDone` is expected to be called with a specific error shape on the abort path. Mitigation: `onDone` is the "normal completion" callback in this API; on abort, the caller has already chosen to abandon the stream, so invoking `onDone` is the documented completion. No error path is introduced.
- **Trade-off:** Parallelizing `embedPages` increases peak outbound HTTP concurrency. The limiter respects `cfg.concurrency`, which is the same knob `embedAllPages` already uses, so the system-wide cap is unchanged.

## Migration Plan

None. All changes are additive to the failure path or performance-only. Rollback is a revert of the commit.

## Open Questions

(none)
