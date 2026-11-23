# frontend-performance-budget

## ADDED Requirements

### Requirement: The app has a documented bundle-size budget

`package.json` SHALL define a size budget (via `size-limit` or a `vite-bundle-visualizer` + CI threshold) such that the main chunk does not exceed a documented byte count, and the whole app's gzipped bundle does not exceed a documented total. The budget SHALL be expressed in a `size-limit` block (or equivalent) with both per-chunk and total limits.

#### Scenario: A new dependency is added

- **WHEN** a developer adds a 200 KB dependency to the main entry
- **AND** the build succeeds
- **THEN** the size-limit check fails in CI with a diff against the last recorded budget
- **AND** the developer either (a) splits the dependency into a lazy chunk or (b) updates the budget with a one-line justification in the PR description

#### Scenario: The budget file records the accepted numbers

- **WHEN** the repo is in a healthy state
- **THEN** a single file (e.g. `.size-limit.json` or a `size-limit` key in `package.json`) lists the accepted per-chunk and total budgets
- **AND** the file is owned by whoever last changed the budget

### Requirement: Heavy views and sections are lazy-loaded

`src/App.tsx` SHALL lazy-load the following views via `React.lazy`: the graph view, the settings view, and the chat panel's heavy dependencies (mermaid renderer, markdown renderer). Each lazy chunk SHALL have a named `React.Suspense` fallback.

#### Scenario: Opening the settings view does not block initial paint

- **WHEN** the app first mounts
- **THEN** the initial chunk does not include the mermaid renderer, the settings sections, or the graph view
- **AND** those chunks download on demand when the user first opens the corresponding view

#### Scenario: A lazy chunk fails to load

- **WHEN** a lazy chunk fails to download
- **THEN** the user sees the named `Suspense` fallback for that view
- **AND** an error boundary for that chunk offers a "retry" action

### Requirement: The graph view does not block the main thread for more than 100 ms in one frame

The `graph-view.tsx` rendering loop SHALL not exceed 100 ms of main-thread work per frame when rendering a graph of up to 2,000 nodes. This SHALL be measured with `PerformanceObserver` (or an equivalent dev-time budget) and enforced as a lint / test warning.

#### Scenario: A large graph renders in chunks

- **WHEN** the user opens a project with 2,000 graph nodes
- **THEN** no single `requestAnimationFrame` callback exceeds 100 ms
- **AND** the graph is drawn in incremental frames (e.g. 100 nodes per frame)

## Verification

- `npm run build` produces a bundle whose main chunk and total size are within the documented budget; a size-limit check runs in CI.
- `React.lazy` is present in `src/App.tsx` for the graph view, the settings view, and the chat's heavy dependencies.
- The graph view test asserts frame time < 100 ms at 2,000 nodes (dev-time; the assertion is a warning, not a failure, to allow flaky CI).
