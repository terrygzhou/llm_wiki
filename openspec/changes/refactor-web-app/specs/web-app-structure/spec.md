# web-app-structure

## ADDED Requirements

### Requirement: Frontend code is organized by domain

The frontend `src/` tree SHALL organize implementation modules under domain folders (`ingest/`, `embed/`, `chat/`, `graph/`, `i18n-support/`, `tauri/`, `utils/`) such that no domain folder exceeds 40 files and any newly added module has a single-owner domain. A module that belongs to two domains SHALL live in the domain that owns it and be re-exported through the other's barrel only for read access.

#### Scenario: A new ingest module lands in the correct folder

- **WHEN** a developer adds a new ingest-queue helper
- **THEN** the file lives under `src/lib/ingest/`
- **AND** it is re-exported through `src/lib/ingest/index.ts`
- **AND** the file colocates its test as `src/lib/ingest/<name>.test.ts`

#### Scenario: A cross-cutting utility is not domain-owned

- **WHEN** a module has no single owning domain (e.g. a date-formatting helper used by chat and settings)
- **THEN** the module lives in `src/lib/utils/`
- **AND** at least two call sites from two different domains exist in the codebase

### Requirement: `src/lib/ingest` is exposed only through its barrel

The `src/lib/ingest/index.ts` barrel SHALL be the only public surface for ingest logic. No file outside `src/lib/ingest/` SHALL import from `src/lib/ingest/<submodule>` directly.

#### Scenario: A chat feature needs ingest status

- **WHEN** a chat component reads ingest status
- **THEN** it imports from `@/lib/ingest` (the barrel), not from `@/lib/ingest/queue`
- **AND** a lint rule (`import/no-restricted-paths` or a path-alias guard) enforces this

### Requirement: No legacy flat files remain

After the migration, the only top-level files in `src/lib/` that are implementation modules SHALL be those with no single owning domain. Every implementation module that has an owner SHALL live inside its owner's domain folder.

#### Scenario: A module with an owner is not at the top

- **WHEN** a code reviewer looks at `src/lib/`
- **THEN** any file matching `embed*`, `ingest*`, `chat-*`, or `graph-*` is either gone (moved to its domain folder) or a re-export shim inside `src/lib/` that the next PR removes

## Verification

- `ls src/lib` returns no `*.ts` implementation file whose owner domain is not top-level.
- An ESLint `import/no-restricted-paths` rule passes for the barrel import.
- `tsc --noEmit` passes and all colocated tests pass.
