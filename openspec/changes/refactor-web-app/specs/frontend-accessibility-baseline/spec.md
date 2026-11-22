# frontend-accessibility-baseline

## ADDED Requirements

### Requirement: The chat stream announces updates to assistive technology

The chat message list SHALL use `aria-live="polite"` so screen readers announce new assistant messages. Each new user / assistant message appended to the list SHALL be wrapped in a `role="listitem"` parent with `role="list"` on the container.

#### Scenario: An assistant reply streams in

- **WHEN** the assistant streams a reply
- **AND** a screen-reader user has focus inside the chat panel
- **THEN** the screen reader announces the new message once it is committed (not on every streamed token)

#### Scenario: A user sends a message

- **WHEN** the user submits a prompt
- **THEN** the user's message is announced to the screen reader as a new list item
- **AND** the focus does not move off the chat input (the input retains focus so the user can continue typing)

### Requirement: The knowledge tree is keyboard-navigable

The knowledge tree in `src/components/layout/knowledge-tree.tsx` SHALL be navigable by keyboard: `ArrowUp` / `ArrowDown` move between visible nodes, `ArrowRight` expands a collapsed node (or moves to the first child if already expanded), `ArrowLeft` collapses an expanded node (or moves to the parent), `Enter` selects a node.

#### Scenario: A keyboard user traverses the tree

- **WHEN** the user presses `Tab` into the knowledge tree
- **AND** then uses the arrow keys to move to the file they want
- **THEN** the focused node is visually indicated (CSS focus ring)
- **AND** `Enter` opens the file in the preview

#### Scenario: The tree state is announced

- **WHEN** a node is expanded
- **THEN** the node element has `aria-expanded="true"`
- **AND** its children container has `role="tree"` and the child nodes have `role="treeitem"`

### Requirement: The settings tabs use `role="tablist"`

The settings view SHALL use `role="tablist"` on the tab strip and `role="tab"` with `aria-selected` on each tab. The corresponding content area SHALL use `role="tabpanel"` with `aria-labelledby` pointing at the active tab.

#### Scenario: A keyboard user opens a settings section

- **WHEN** the user tabs into the settings tab strip
- **AND** presses `Enter` on the "LLM Provider" tab
- **THEN** the LLM provider section becomes visible
- **AND** the tab strip announces "LLM Provider, tab, 1 of N, selected" to the screen reader

### Requirement: An automated a11y gate blocks new violations

A Playwright test (`tests/a11y/*.spec.ts` or equivalent) SHALL run `@axe-core/playwright` on at least the chat panel, the knowledge tree, and the settings view. The gate SHALL fail CI on new violations relative to a recorded baseline.

#### Scenario: A new component lands with a violation

- **WHEN** a new settings section is merged that renders an unlabeled `<input>`
- **THEN** the a11y Playwright test fails in CI with the axe violation diff
- **AND** the PR cannot merge until the input has an accessible label or `aria-label`

## Verification

- `grep -rn "aria-live" src/components/chat` returns at least one match on the message list.
- `grep -rn "role=\"tablist\"" src/components/settings` returns at least one match.
- The Playwright a11y spec passes on a clean tree and fails on an injected violation.
- `npm test` (a11y subset) runs in CI.
