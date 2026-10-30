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
- Actual P2 originals were saved before protected grading sources were returned. Progress correctly reports pending grades; no P2 score was committed.
- Commit `edffcdbdf92a38df182f194e202b68af977b8120`: GitHub Actions run `41074861628` succeeded; Vercel reported successful Preview deployment. These checks do not establish semantic grading accuracy or Drive access.
- Actual repeated model evaluation found classification instability. Source-only fixed criteria improved one tested pair to identical classifications and scores across three runs; evidence excerpts differed. This is limited consistency evidence, not a general accuracy pass.
- Added a private fixed-criteria validator and separated classification agreement from excerpt agreement. Initial `npm test`: 138 passed, zero failed/skipped.

## October 31 follow-up
- Connected fixed-criteria validation conditionally to prepare/commit when the exact encrypted key snapshot contains the manifest. Legacy snapshots are unchanged; no actual key was republished. The global P2 gate remains closed.
- `node test/exam-flow.integration.mjs` against disposable localhost PostgreSQL 18: exit 0. Fixed denominator enforcement, rejection of caller manifest replacement, rollback/original preservation, previous key snapshot preservation and valid commit replay passed. The temporary container was removed; operating services were not changed.
- The private evaluation runner omitted the issued question context. Those results are invalid as learner scores. Added a required-context input builder with issued prompt digest verification; actual prompt hashes match all three issued snapshots. Re-evaluation remains separate from mechanical test success.
- `npm test`: 141 passed, zero failed/skipped. `git diff --check`: exit 0. No private prompt, original, model answer or rubric is included in this evidence.

## Still unverified
P2 semantic acceptance and authenticated score commit; Vercel Drive OAuth runtime; production transition. Drive diagnostic code and local tests exist, but no authenticated deployed diagnostic request was sent because the CLI returned empty sensitive Preview values. P2 commit deployment gate remains unchanged. No merge or production cutover.
