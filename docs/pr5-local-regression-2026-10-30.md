# PR5 local regression follow-up

Baseline: 0571f9096fc23fb3012250dd67de14ccc51b6129. No operating data changed.

## Changes
- Preserve unknown scores/dates and immutable history objects in progress reads.
- Exclude P2 grade rows without original answers from attempted/latest-score filters.
- Serialize issue allocation per owner/subject/stage, including distinct request IDs, to prevent overlapping active sets.
- Limit missing Drive document review to folders actually scanned.
- Add offline repeated P2 evaluation comparison with redacted summaries. This does not establish AI semantic accuracy or enable grade commit.

## Executed
- npm test: 130 passed, zero failed/skipped.
- node --test tests/*.test.js: 12 passed.
- python -m pytest -q tests: 17 passed.
- npx next build --webpack: exit 0. Standard CI build remains separate.
- test/exam-flow.integration.mjs: exit 0 against newly created disposable localhost PostgreSQL 18. P1 issue/grade, P2 partial submission and ratio record, ownership, immutable resubmission, replay, omitted-answer review exclusion and concurrent distinct-request allocation passed. Synthetic fixture only. Temporary container removed.
- Local synthetic 12 samples: P1 issue p50/p95 8.640/12.071ms; grade 16.170/18.668ms. Not ChatGPT/network/AI timing and not a before/after speed claim.

## Authenticated Preview follow-up
- Existing WorkOS login completed. The connected runtime now exposes the six Preview tools; authenticated progress, P1 issue/grade and P2 issue/prepare calls succeeded. A separate raw `tools/list` response was not captured.
- Actual P1 submission was graded and its progress records read back. Repeating issue and grade requests returned replay results without increasing attempts. Private answers, problem keys and user identifiers are intentionally omitted here.
- Actual P2 originals were saved before protected grading sources were returned. They initially remained pending; the bounded acceptance run below subsequently committed and verified them.
- Commit `edffcdbdf92a38df182f194e202b68af977b8120`: GitHub Actions run `41074861628` succeeded; Vercel reported successful Preview deployment. These checks do not establish semantic grading accuracy or Drive access.
- Actual repeated model evaluation found classification instability. Source-only fixed criteria improved one tested pair to identical classifications and scores across three runs; evidence excerpts differed. This is limited consistency evidence, not a general accuracy pass.
- Added a private fixed-criteria validator and separated classification agreement from excerpt agreement. Initial `npm test`: 138 passed, zero failed/skipped.

## October 31 follow-up
- Connected fixed-criteria validation conditionally to prepare/commit when the exact encrypted key snapshot contains the manifest. Legacy snapshots are unchanged; no actual key was republished. The global P2 gate remains closed.
- `node test/exam-flow.integration.mjs` against disposable localhost PostgreSQL 18: exit 0. Fixed denominator enforcement, rejection of caller manifest replacement, rollback/original preservation, previous key snapshot preservation and valid commit replay passed. The temporary container was removed; operating services were not changed.
- The private evaluation runner omitted the issued question context. Those results are invalid as learner scores. Added a required-context input builder with issued prompt digest verification; actual prompt hashes match all three issued snapshots. Re-evaluation remains separate from mechanical test success.
- `npm test`: 141 passed, zero failed/skipped. `git diff --check`: exit 0. No private prompt, original, model answer or rubric is included in this evidence.

## Bounded authenticated P2 acceptance
- After correcting context omission and duplicate criteria, all three actual answers were evaluated three times against fixed, independently reviewed criteria. Classifications and points agreed in all nine evaluations; this is evidence for these samples, not universal semantic accuracy.
- Added `P2_GRADE_COMMIT_ALLOWED_SET_IDS` as an additional exact-set restriction. `npm test`: 143 passed, zero failed/skipped. Commit `2daa8ebb9148255ea03433d8188336efe82a94dc` passed GitHub Actions run `41078846350` and Vercel Preview deployment.
- Enabled P2 commit temporarily only in the existing test Preview branch, restricted to the reviewed set. The first MCP call failed schema validation because a diagnostic array entry was an object rather than a string; no write occurred. Normalized that diagnostic to its existing explanation string without changing element judgments or points, then the authenticated MCP commit succeeded.
- Repeating the exact accepted payload returned replay. Progress readback after replay showed one attempt per submitted item, verified history, score rates, mastery and review dates. No original answer or past key was changed.
- Restored the branch gate to false and redeployed the same test Preview. A real MCP commit probe then returned `P2 grade commit awaits official accuracy acceptance`, confirming closure. No production environment, main merge or operating data was changed.

## Still unverified
Broad P2 semantic acceptance beyond the reviewed samples, approved fixed-criteria supply for other keys, Vercel Drive OAuth runtime and production transition remain open. Drive diagnostic code and local tests exist, but no authenticated deployed diagnostic request was sent because the CLI returned empty sensitive Preview values. P2 commit deployment gate is closed again. No merge or production cutover.

## Ratio-policy and readiness follow-up
- Clarified fixed meaning-element ratio scoring, semantic equivalence, partial-credit boundaries and separate diagnostics. Internal official point partitions are not claimed as supported by the current equal-element calculator.
- Reject non-string diagnostic entries in the private semantic audit, preventing an object from passing locally only to fail the MCP schema later.
- Source-change selection now compares the latest actual committed original rather than any historical version. Re-solving the current version clears the change; omitted, blank, pending and other-owner/stage records do not clear it.
- `npm test`: 147 passed, zero failed/skipped. `node test/source-changed.readonly.integration.mjs`: 18 assertions passed against disposable localhost PostgreSQL 18, using synthetic CTEs in a read-only transaction. Temporary container removed. `git diff --check`: exit 0.
- Drive diagnostic remains blocked at caller credential supply: no current process or checked existing local environment provides the maintenance token. WorkOS user authentication is not administrator route authorization. No token was rotated and no configuration or operating data changed during this follow-up.
