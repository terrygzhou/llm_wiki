# chat-component-boundaries

## ADDED Requirements

### Requirement: Chat components are thin compositions

`src/components/chat/chat-panel.tsx` SHALL not exceed 400 lines and SHALL delegate to extracted sub-components: message rendering under `chat/message/`, input composition under `chat/input/`, and scroll/panel orchestration under `chat/panel/`. `chat-message.tsx` SHALL delegate rendering of individual blocks (code, image, tool call, citation) to `chat/message/*` sub-components.

#### Scenario: A new message block type is added

- **WHEN** a developer adds a new message block renderer (e.g. a "diff" block)
- **THEN** the renderer lives in `src/components/chat/message/<block>-block.tsx`
- **AND** `chat-message.tsx` is updated only to add the dispatch branch — its line count changes by less than 30 lines
- **AND** the new block has a colocated test in `src/components/chat/message/__tests__/`

#### Scenario: A regression test targets a sub-component, not the panel

- **WHEN** a test asserts the auto-scroll behavior of the message list
- **THEN** the test imports from `src/components/chat/panel/use-message-list-scroll.ts` (a hook), not from `chat-panel.tsx`

### Requirement: No chat file exceeds 400 lines

After the refactor, no file under `src/components/chat/` SHALL exceed 400 lines. The 2k-line `chat-panel.tsx` and 1.7k-line `chat-message.tsx` are the seeds of this split.

#### Scenario: A reviewer measures the diff

- **WHEN** the change is merged
- **THEN** `find src/components/chat -name "*.tsx" -exec wc -l {} \;` returns no file over 400 lines
- **AND** `chat-panel.tsx` is under 400 lines and `chat-message.tsx` is under 400 lines

## Verification

- `find src/components/chat -name "*.tsx" | xargs wc -l | sort -rn` shows no file over 400 lines.
- A `chat-panel.tsx` diff does not add new block renderers; it only adds a dispatch branch.
- All existing chat tests pass; new sub-component tests are colocated.
