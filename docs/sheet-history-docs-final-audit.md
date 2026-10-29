# Exam history and Docs read-only acceptance — 2026-10-30

This audit compares records, not the retired Google Sheets selection seed or ordering. No source Sheet/Doc/Apps Script was changed. No user answer, owner ID, private rubric, row-level fingerprint, or credential is stored here.

## Historical record populations

| Source or state | Count | Meaning |
| --- | ---: | --- |
| Operating problem ledger | 9,445 keys | Same unordered key set in test PostgreSQL. State counts match: 4,150 active unchanged, 4,178 active new, 1 active body-changed, 1,116 archived. |
| Operating Sheet valid history | 640 rows | Every row matched a row in the independent test Sheet copy by key, set, date, score and maximum. |
| Independent test Sheet valid history | 861 rows | 221 more than the operating Sheet copy. These are test-copy records, not assumed operating history. |
| PostgreSQL `SHEET_HISTORY_IMPORTED` | 855 rows | Exact key/set/score/maximum/validity match to 855 test Sheet rows; original attempt dates were also compared 855/855. Import event time is **not** the played date. |
| Test Sheet rows not represented as imported events | 6 rows | All are P2 with a valid dated score, maximum and original in the Sheet. Their DB sets remain `PREPARED`, originals exist, and no grade is recorded. Five are also in the operating Sheet history. Quarantined: no fabricated evaluation, score or state transition. |
| DB native grade rows | P1 842; P2 24 | Native grade-table counts; cannot add to 855 imports without deduplicating matching set IDs. |
| DB review schedule rows | 852 | Distinct native graded owner/problem pairs, not 855 imported events. Imported events contain 841 distinct owner/problem pairs. These counts use different populations. |
| DB P2 `PREPARED` originals without grade | 3 sets, 7 subquestions | Six correspond to the test Sheet gap above; the remaining existing submitted original is separate. All remain unchanged. |

The read-only comparison found P1 correctness equal for 832/832 valid test Sheet grade rows and 632/632 operating Sheet rows. P2 numeric score, maximum and seven diagnostics matched for 23/23 test Sheet graded rows and 3/3 operating Sheet rows. The six `PREPARED` gaps are excluded from these verified-grade denominators. Progress now marks a `PREPARED` nonblank original as `확인 필요` rather than incorrectly reporting it unattempted. Test Railway read-only smoke check returned a pending problem with `pending_grade`, and the owner aggregate placed pending items under `unknown`.

## Google Docs format and sync

The three existing Docs retain their authoring format. Read-only ChatGPT app calls on this date returned 5,451 (`SRC-CIV-004`), 2,765 (`SRC-CIV-004B`) and 113 (`SRC-CIV-005`) unique stable keys, all present in DB; no new, deleted or conflicting duplicate key. Parser occurrences include 200 and 159 identical repeated appearances in the first two Docs, respectively. Content differences remain 2 in `SRC-CIV-004B` and 9 in `SRC-CIV-005`; all 11 remain unapproved and unapplied. Rendering-only normalization accounts for 2 and 101 additional matches in the first and third Docs.

Existing-format synthetic P1 insertion and P2 case/subquestion tests preserve old stable keys and omit answer/rubric material from public snapshots. Docs parser/snapshot/sync unit suite: **30/30 pass**. The earlier disposable PostgreSQL drill passed approved synthetic NEW/MODIFIED application, idempotent replay, old issued version preservation and conflict rollback. Docker was unavailable during this 2026-10-30 audit, so that integration drill was not repeated today. A real newly authored Docs problem still needs an approved grading key before publication and issue; no operating Doc was edited to manufacture one.

## Safe disposition

Keep the six missing imported events and all seven `PREPARED` originals under review. A future repair must trace each Sheet row to its owner, stable key, set and official grading source, prove no duplicate native event, test the repair in an isolated DB, then compare before/after counts. No automatic historical grade reconstruction is authorized by this audit.
