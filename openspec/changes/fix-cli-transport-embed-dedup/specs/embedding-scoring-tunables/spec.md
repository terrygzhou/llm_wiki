# embedding-scoring-tunables

## ADDED Requirements

### Requirement: Vector search candidate floor and tail-blend weight are documented constants
The vector-search scoring path SHALL keep its candidate-fetch floor (`max(topK * 3, 30)` — the minimum number of raw candidates fetched from the vector index before per-page blending) and its tail-blend weight (`0.3` — the multiplier applied to the sum of non-top chunk scores when blending a page's score, capped at `1 - top`) as named or clearly commented in-code constants, so a future change to either value is recognized as an intentional tuning change rather than an accidental edit.

#### Scenario: Constants are visible to a reader
- **WHEN** a developer opens the file containing the vector-search scoring
- **THEN** each of the two values is annotated with a short comment stating what it controls and why the current value was chosen
- **AND** changing either value does not require searching for an unexplained literal elsewhere

#### Scenario: Tuning one constant does not break the other
- **WHEN** the candidate floor is changed (e.g. to `Math.max(topK * 5, 50)`)
- **THEN** the tail-blend weight and its cap remain in effect and scoring still produces a single blended per-page score
- **AND** no other call site assumes the old floor literal

## REMOVED Requirements

(none)
