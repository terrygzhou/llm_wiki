# store-boundaries

## ADDED Requirements

### Requirement: Each store owns exactly one domain

Every file under `src/stores/` SHALL own a single domain. No store SHALL write to a domain it does not own. Domains: `wiki/files`, `wiki/selection`, `wiki/ingest-status`, `chat`, `activity`, `lint`, `research`, `review`, `update`, `app-dialog`, `file-sync`, `zoom`.

#### Scenario: A new ingest field is added to the wiki store

- **WHEN** a developer adds an `ingestProgress` field
- **THEN** the field lives in `src/stores/wiki-ingest-status-store.ts`, not in `wiki-store.ts`
- **AND** the docs file `docs/stores.md` is updated to describe the field's owner

### Requirement: `wiki-store.ts` is split into three stores

The monolithic `wiki-store.ts` (701 lines) SHALL be split into:

- `wiki-files-store.ts` — file tree state (tree, expanded nodes, selected file).
- `wiki-selection-store.ts` — selection / focus state (currently-selected file, pinned files, scroll position).
- `wiki-ingest-status-store.ts` — ingest / import status (in-flight ingest, last import error, import progress).

Existing call sites that import `wiki-store` SHALL be migrated one file at a time; the old `wiki-store.ts` SHALL be left as a re-export shim (`export * from "@/stores/wiki-files-store"` etc.) until the next PR removes it.

#### Scenario: A store test targets the correct domain

- **WHEN** a test asserts that ingesting a file updates the progress bar
- **THEN** the test imports from `wiki-ingest-status-store`, not from `wiki-store`
- **AND** `wiki-store`'s test file is gone (replaced by the three domain tests)

### Requirement: Stores do not reach into each other's internals

A store module SHALL NOT call another store's actions. Cross-domain composition SHALL happen at the component level.

#### Scenario: A developer wants to sync selection when ingest completes

- **WHEN** the developer needs to clear the file selection when an import finishes
- **THEN** they write a hook or component that subscribes to both stores, not a cross-store `useEffect`
- **AND** no `select` call from one store appears in another store's source

## Verification

- `ls src/stores` shows `wiki-files-store.ts`, `wiki-selection-store.ts`, `wiki-ingest-status-store.ts` (the `wiki-store.ts` shim may exist during migration only).
- `docs/stores.md` exists and names every domain and its owner.
- No `*.ts` under `src/stores/` imports another store module.
