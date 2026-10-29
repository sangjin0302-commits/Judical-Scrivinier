# Existing Google Docs format and safe exam sync

Scope: three approved Docs sources only. `SRC-CIV-004` and `SRC-CIV-004B` retain `[문항ID] 제목 | O/X` plus `지문:` format. `SRC-CIV-005` retains `YYYY년도 (제N회)` → `문 N` → `문제` → case facts → `현실답안 및 해설` → `현실답안` headings. No new authoring template is required.

The parser creates P1 stable keys from the bracketed source ID and P2 stable keys from year, exam, main question and ordered answer heading. Case prompt includes the facts and target heading, not model-answer text. Parser tests cover compact P1 headings, editorial corrections, split P2 subquestions, answer headings before the explanation delimiter, and synthetic later P1/P2 additions with multiple P2 subquestions. Snapshot tests verify new P2 keys, full case grouping, no inferred grading key, and NEW candidate classification.

Inserting a new P1 question before an existing one changes source order but retains the old stable key. The detector classifies the existing text as UNCHANGED and the inserted item as NEW. Source order by itself does not rewrite earlier issued versions.

Docs supply question text only. A new question enters PostgreSQL as an unpublished problem version; it cannot be issued until official grading material is separately verified and activated. Duplicate stable keys and stale candidate versions fail closed. A changed old question and unrelated new question are separate candidates, so an unapproved old difference does not automatically block a new question. Content and grading changes require separate approvals; apply is transactional and preserves prior versions and issued-set snapshots.

Previously observed 11 content differences remain unapproved and unapplied. The newly added tests use synthetic content. They prove parser and workflow contracts, not full parity with all 8,329 live keys or a live Railway write. The existing read-only preview count and isolated PostgreSQL synthetic apply/rollback drill remain the available live-source and write-path evidence. A final acceptance run still needs one approved new Docs-format item and a separately verified grading key, followed by an isolated DB issue/grade test; do not alter operating Docs to manufacture that item.

## 2026-10-29 read-only live-source rerun

The existing deployed MCP read-only preview and parity tools parsed all three approved Docs against the test PostgreSQL: 5,451 + 2,765 + 113 = **8,329 unique stable keys**. Missing in either direction: 0. Conflicting duplicate keys: 0. Identical duplicate occurrences in Docs: 200 + 159 + 0. Candidate counts: NEW 0, MODIFIED 11 (0 + 2 + 9), UNCHANGED 8,318, DUPLICATE 0, DELETE_CANDIDATE 0. Prompt parity additionally found 103 rendering-normalized matches and 11 unresolved content mismatches. No candidate detection, approval, apply or source write was called. This verifies the deployed parser's current corpus shape; local uncommitted changes still require deployment and rerun before claiming new-code live parity.
