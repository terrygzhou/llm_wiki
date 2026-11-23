# frontend-type-hygiene

## ADDED Requirements

### Requirement: No `: any` remains in `src/stores` and `src/components/chat`

After the refactor, `grep -rn ": any" src/stores src/components/chat` SHALL return zero matches. Any remaining `: any` SHALL be replaced with an explicit type from `src/types/wiki.ts` or a new module under `src/types/`.

#### Scenario: A store action takes a generic callback

- **WHEN** a store action accepts a callback parameter
- **THEN** the callback is typed with an explicit generic (`<T>` parameter) or a concrete type
- **AND** no `: any` appears in the signature

#### Scenario: A chat message block has a shape

- **WHEN** a developer adds a new message block type
- **THEN** the block's data shape is defined in `src/types/chat-message.ts` (or a sibling module)
- **AND** the block's component is typed against that shape

### Requirement: `@typescript-eslint/no-explicit-any` is configured as warn globally and error in `src/components`

The ESLint config SHALL configure `@typescript-eslint/no-explicit-any` as `warn` for the whole app and as `error` for files under `src/components/`. This SHALL be a hard gate in CI: any `error`-level violation fails the build.

#### Scenario: A developer adds an `any` in a component

- **WHEN** a component in `src/components/` is merged with a new `: any`
- **THEN** the ESLint step fails in CI
- **AND** the developer must replace the `any` with a concrete type or an `eslint-disable-next-line` comment with a justification

#### Scenario: A legacy `any` outside `src/components` is tolerated

- **WHEN** a file in `src/lib/` still has a `: any`
- **THEN** the lint passes with a warning
- **AND** the warning is recorded in the PR log (to track the count)

### Requirement: `tsconfig.app.json` keeps `noImplicitAny` enabled

The app's TypeScript config SHALL keep `noImplicitAny: true` and `strict: true`. New code that implicitly infers `any` (e.g. an untyped `catch (e)` that is then used) SHALL be rejected at compile time.

#### Scenario: An untyped catch block

- **WHEN** a developer writes `try { ... } catch (e) { e.message }` without typing `e`
- **THEN** `tsc --noEmit` fails with `Type 'unknown' has no property 'message'`
- **AND** the developer adds `catch (e: unknown)` and narrows

## Verification

- `grep -rn ": any" src/stores src/components/chat` returns zero matches.
- ESLint reports `0 errors` on `src/components/` and the total `any` count in `src/lib/` does not increase relative to the baseline recorded in `tasks.md`.
- `tsc --noEmit` passes.
