# dedup-embedding-throughput

## MODIFIED Requirements

### Requirement: Page embedding respects the configured concurrency
The batch page-embedding path SHALL run at most `cfg.concurrency` embedding operations in flight at once, instead of strictly sequentially, so a large corpus finishes in roughly `ceil(pages / concurrency)` times the cost of one embedding.

#### Scenario: Large corpus embeds in bounded wall time
- **WHEN** `embedPages` is called with 5000 pages and a concurrency of 8
- **THEN** at most 8 embedding operations are in flight at any moment
- **AND** total wall time is on the order of the sequential cost divided by 8, not the full sequential cost

#### Scenario: Concurrency of 1 preserves sequential behavior
- **WHEN** the configured concurrency is 1
- **AND** `embedPages` is called
- **THEN** results are computed and returned in the same order as before (page i's result is always the i-th result), regardless of which page finished first in the pool

#### Scenario: A single page fails
- **WHEN** one page in the batch fails to embed
- **THEN** the failure is reported for that page, and the remaining pages still complete
- **AND** the function does not leave any in-flight work abandoned without observation (errors are collected, not swallowed)
