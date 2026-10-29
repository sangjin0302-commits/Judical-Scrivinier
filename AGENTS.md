# Codex guidance — official exam-only integration

## Scope
- This branch supports official civil-law P1/P2 question selection, submission, grading, history and guarded Google Docs synchronization. Do NOT implement concept tutoring, lesson generation, recall questions or progress tracking.
- Read PROJECT_INSTRUCTIONS.md; refer as needed to docs/exam-only-integration.md, EXAM_SELECTION_PARITY_AUDIT.md and docs/p2-official-accuracy-gate.md.
- Keep existing production Google Sheets/Docs/Apps Script read-only; work with isolated test PostgreSQL. No new infrastructure, credentials or paid services. No secrets, personal answers, official keys or copyrighted full problem text in GitHub/logs.

## Codex subagents
- On substantial unfinished work, delegate 3 independent streams to project agents: exam_selection (P1/P2 parity), p2_grading (meaningful grading validity) and docs_sync (safe incrementals). Wait for results and integrate them in the main thread.
- Agents must have disjoint edits. The parent coordinator exclusively changes shared db/postgres-adapter.mjs, server.mjs and app/mcp/route.js and performs integration/migration execution. Never run concurrent writes to the same Railway DB or Git branch.
- Agents report concise evidence and unverified issues; coordinator verifies, runs CI-equivalent tests, reviews security, and commits/pushes non-secret code (including labeled WIP) with confirmed remote SHA. Avoid rereading already verified work; cap active subagents at 3.

## Release and safety gates
- Actual P1 candidate selection must match Sheets quotas, modes, scope and seeded priority order. Actual P2 must select groups and all subquestions. Missing metadata must fail closed, not fall back to random.
- P2 must lock the actual answer before fetching any private rubric; do not fabricate official awarded points or credit abstention, and preserve seven dimensions, semantic match evidence, original answers and idempotence.
- Docs: 11 unresolved differences remain quarantined. Test explicitly approved synthetic NEW/MODIFIED changes in an isolated DB, including version preservation, authorization, idempotence and rollback. Never auto-approve content.
- Prior to merge, run full tests, secret scans, authenticated ChatGPT P1/P2 E2E and DB/history parity checks. Automated checks alone are insufficient.
- PR #5 is the sole main integration candidate. PR #1/#2/#3/#4 are not to be wholesale merged. Merging main and switching the operating database are distinct; operating data cutover always requires separate user approval. Only merge PR #5 after all applicable gates pass and the current request explicitly authorizes it.
