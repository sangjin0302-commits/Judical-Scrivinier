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

## Still unverified
Authenticated Preview tools/list and ChatGPT E2E; real P2 non-abstention repeated model classifications; Vercel Drive OAuth runtime; production transition. P2 commit deployment gate remains unchanged. No merge or production cutover.
