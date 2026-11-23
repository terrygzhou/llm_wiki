# frontend-testability

## ADDED Requirements

### Requirement: Test fixtures are centralized under `src/test-helpers/fixtures/`

Store and component tests SHALL consume shared fixtures from `src/test-helpers/fixtures/` (mock projects, mock LLM responses, mock Tauri command results, mock chat histories). No test SHALL construct the same mock inline across multiple files.

#### Scenario: A store test needs a mock project

- **WHEN** a store test builds a project object
- **THEN** it imports `makeMockProject` from `src/test-helpers/fixtures/mock-project.ts`
- **AND** the fixture is used by at least two test files
- **AND** the fixture exposes stable fields (id, name, files) with optional overrides

#### Scenario: A component test needs a mock Tauri command

- **WHEN** a component calls `invoke("ingest", ...)`
- **THEN** the test stubs the command via `mockInvoke("ingest", makeMockIngestResult(...))`
- **AND** the mock lives in `src/test-helpers/fixtures/mock-tauri.ts`

### Requirement: `createTestTransport` mimics the CLI transport stream shape

`src/test-helpers/createTestTransport.ts` SHALL expose a test-only transport that emits a sequence of stream events matching the shape of the real `claude-cli-transport` / `codex-cli-transport` streams. Tests that assert against stream semantics SHALL use this helper rather than re-implementing the stream shape inline.

#### Scenario: A chat test asserts against a multi-message stream

- **WHEN** a test asserts that the chat panel renders two assistant messages
- **THEN** the test calls `createTestTransport({ messages: [...] })` and passes the resulting transport to the panel
- **AND** the helper emits the same event names and ordering as the real transport

#### Scenario: An abort test simulates a mid-stream abort

- **WHEN** a test asserts that an in-flight stream is aborted
- **THEN** the test calls `createTestTransport` with an `AbortController` and verifies the panel's abort-path UI

### Requirement: Store actions are pure and testable without a browser

Each store's public actions SHALL be pure (no DOM access, no global `window` access, no side effects outside the store) such that a store test can run in Node without `jsdom` or a browser. A store test that requires the DOM SHALL be moved to a component test that exercises the store through a component.

#### Scenario: A store test runs in Node

- **WHEN** `npm test` runs `src/stores/wiki-files-store.test.ts`
- **THEN** the test passes without `jsdom`
- **AND** the test does not import from `document` or `window`

## Verification

- `ls src/test-helpers/fixtures/` shows the shared fixtures.
- No `*.test.ts` under `src/stores/` or `src/components/` imports from `src/test-helpers/fixtures/` fewer than twice (a fixture used once is a code smell; it should be inlined).
- `createTestTransport` is imported by at least two test files.
- `npm test` passes in a Node-only environment for store tests.
