# Official civil exam integration

## Scope
- Support official P1/P2 issue, submission, grading, immutable history and exam progress; WorkOS, PostgreSQL and guarded Google Docs sync. Do not develop concept lessons, recall, concept progress or study modes. Preserve existing concept tables and records.
- Read `PROJECT_INSTRUCTIONS.md` and `docs/exam-only-integration.md`. Current user decisions override older audits. Sheets controls must remain available to users through PostgreSQL: range/type/count/cases, year/session/question/stable key, unattempted/incorrect/low score/due/source change, active-set exclusion and problem progress. Do not clone old Sheet seed or cell formulas.
- Keep operating Google Sheets, Docs and Apps Script read-only; do not change Docs authoring format. Do not create new infrastructure, credentials or paid services.

## Parallel work
- For substantial independent work, delegate exam selection, P2 grading and Docs sync to agents. Keep edits disjoint; coordinate shared adapter/server/route changes through the parent. Do not run concurrent writes to the same Railway DB or Git branch.
- Parent checks agent results, runs integrated tests and security scans, and commits/pushes safe code including labeled WIP. Confirm remote SHA. Avoid repeating already verified work.

## Release and safety
- Preserve stable problem keys, versions, original answers, encrypted grading keys and past scores. No secrets, private keys, personal answers, DB dumps or full copyrighted problem text in GitHub/logs.
- P2: persist submitted originals before rubric access. Official model-answer elements score 1/0.5/0 for match/partial/missing or error; seven diagnostics stay separate. Omitted subquestions are not answered attempts. Never label AI learning points as official examiner marks.
- Docs: 11 unresolved content differences stay quarantined. Only approved synthetic NEW/MODIFIED changes may be applied in isolated tests; check version preservation, idempotence and rollback. New items without verified private grading keys stay unpublished.
- Before PR #5 merge, verify every required user function, isolated DB and authenticated ChatGPT P1/P2 calls, security and history parity. PR #1/#2/#3/#4 stay separate; no wholesale merge. Main merge and operating DB cutover are separate; cutover requires separate user approval.
