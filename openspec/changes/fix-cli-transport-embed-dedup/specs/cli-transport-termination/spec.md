# cli-transport-termination

## MODIFIED Requirements

### Requirement: CLI stream completion settles on every abort path
When a CLI-transport stream is aborted at any point after stream setup begins — including between Tauri event-listener registration and the spawn invoke — the stream's exported `completion` promise SHALL settle (resolve), the caller's completion callback SHALL be invoked exactly once, and a best-effort kill SHALL be issued to the owning child process.

#### Scenario: Abort lands between listener registration and spawn
- **WHEN** the abort signal fires after the transport has registered its Tauri event listeners but before the spawn invoke completes
- **THEN** the transport invokes the caller's completion callback exactly once
- **AND** the exported `completion` promise resolves without leaving the caller pending
- **AND** the transport has issued (or attempted) a kill for its stream id, and registered listeners are cleaned up

#### Scenario: Abort before any listener is registered
- **WHEN** the abort signal fires before listener registration begins
- **THEN** the transport invokes the caller's completion callback exactly once and resolves the `completion` promise without spawning a process

#### Scenario: No abort, CLI succeeds
- **WHEN** the CLI process exits with a zero code and no error has been observed
- **THEN** the caller's completion callback is invoked once and the `completion` promise resolves, unchanged from current behavior

## ADDED Requirements

### Requirement: Completion callback is invoked at most once
The transport SHALL invoke the caller's completion callback at most once per stream, regardless of how many aborts, done events, or error events arrive.

#### Scenario: Abort and done event race
- **WHEN** an abort signal and a CLI done event are both observed for the same stream
- **THEN** exactly one of them settles the stream; the other is ignored
- **AND** no duplicate completion callback invocation occurs
