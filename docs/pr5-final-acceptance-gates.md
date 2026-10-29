# PR #5 final acceptance gates

Status: WIP, Draft. Baseline `511e7c072e36433652ee1810ba71771a4193ed51`. This note contains no user answers, rubric text, credentials, or private problem content.

## Passed

- P1 source-backed year/session/question metadata: 1,453 of 8,216 published items. Railway read-only selector replay passed after guarded test-DB application. Unknown metadata stays unknown.
- Docs read-only connected-app parity: 8,329 stable keys, no missing/conflicting keys; 11 unapproved body differences remain unapplied. Targeted Docs tests: 33/33.
- Imported test-Sheet history: 855 matching rows. Six scored Sheet P2 rows remain DB `PREPARED` originals without a grade, marked confirmation needed rather than unattempted. No inferred grade or duplicate history.
- P2 ratio arithmetic and contract tests: targeted 22/22. An existing submitted abstention has zero recognized elements and zero points; original and status unchanged.
- Integrated local checks: MCP 100/100, legacy Node 12/12, Python 17/17. Windows Turbopack build cannot create a junction under current permissions; `next build --webpack` passed. GitHub PR checks: 6 passed, 0 failed.
- PR #5 Vercel Preview reports Ready at the baseline SHA. Existing test Production remains on its prior branch/commit.

## Open merge blockers

1. AI semantic reliability: 24 existing non-abstention P2 graded originals, but only one has a verified current-generation official grading source. Repeated AI meaning classifications of that private pair and controlled quality variants have not been run. Formula and output-shape tests do not prove judgment accuracy. Keep `P2_GRADE_COMMIT_ENABLED` closed; preserve all historical rows.
2. Actual ChatGPT PR #5 E2E: Preview `/mcp` and OAuth metadata are intercepted by Vercel Authentication and redirect to its SSO before WorkOS/MCP. Connected ChatGPT app still exposes the old Production catalog (13 tools), not PR #5's six user tools. Existing-app read-only Docs calls and direct HTTP/SDK checks are not PR #5 ChatGPT acceptance. Do not replace existing test Production or remove Preview protection merely to claim a pass. A safe non-operating ChatGPT-accessible route must be established before retest.
3. Full MCP/ChatGPT roundtrip p50/p95, including separate DB/network/AI timings, cannot be measured until the new endpoint is accessible. Last Railway selection-only reference: P1 292/326 ms, P2 305/318 ms (p50/p95, 12 samples); these are not whole grading latency.

Do not merge PR #5 until all user acceptance gates pass. PR #1-#4 stay separate. Operating Sheets/Docs/Apps Script, production DB, existing concept data, PREPARED originals, and the 11 unapproved Docs differences remain unchanged.
