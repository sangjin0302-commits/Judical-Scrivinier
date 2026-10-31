# Test Railway PITR restore drill — 2026-10-29 KST

Scope: independent test PostgreSQL only. No production Sheets, Docs, Apps Script, or source database writes. This record excludes credentials, grading payloads, and personal answers.

## Result

- Restored timestamp: 2026-10-28 22:30 KST into an isolated sibling Postgres service.
- Restore reached PostgreSQL `ready to accept connections`; read-only client connection succeeded, and `pg_is_in_recovery()` returned false.
- Restored `problems`: 9,445. `private_grading_keys`: 18,890, including 9,445 verified active encrypted keys and 9,445 preserved legacy inactive keys. The ordered ciphertext-and-metadata SHA-256 digest matched the current source exactly; no key or ciphertext was printed.
- Restored `original_answers`: 872. Their ordered answer-digest fingerprint matched the source restricted to records created at or before the restore timestamp. Current source had 873 answers, demonstrating that one later answer was correctly absent from the point-in-time fork.
- Restored `p1_grades`: 842; `p2_grades`: 24; `learning_events`: 866. Current source had 842, 24, and 867 respectively. `issue_sets`: 109 in the fork versus 110 in current source.
- Later concept imports were correctly absent at the selected time: restored `recall_questions`: 0, current source: 720.
- All restore drill services were deleted after testing. Railway service list showed only the original `Postgres` service in `SUCCESS` state.
- Workspace usage at close: about $7.53 accrued and $13.13 estimated for the period, below $20. The temporary $20 hard limit was returned to $15 because accrued and estimated usage were both below $15. Hobby plan unchanged.

## Failed attempts and limits

- A later target (2026-10-29 15:30 KST) exhausted the default 5 GB restore volume while replaying WAL. Its fork was deleted; this does **not** establish that every timestamp in the archive can be restored with the current fork volume size.
- An earlier target (2026-10-28 16:00 KST) replayed WAL but predated the database password rotation; current credentials returned `28P01`. Its fork was deleted. No historic password was retrieved or exposed.
- The successful drill verified preservation of encrypted grading-key bytes and verification state. It did not decrypt grading payloads in the fork, because the grading encryption secret remained confined to the existing Vercel secret store.
- Read-only counts and fingerprints prove selected data and history at one timestamp. They do not replace a full integrity or application acceptance test on the fork.
