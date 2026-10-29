# Official exam selection parity audit (read only)

Date: 2026-10-29 KST. Source: `PB1 Fast Safe v2 독립 테스트 사본 2026-10-28`, bounded formula and configuration reads only. No source Sheet or database changes were made. This is a cutover gate, not evidence that candidate parity has passed.

## P1 rule in the independent test Sheet

- `PB1F_issue` reads enabled rows in `1차통합설정!A4:D`: area, regex scope, count, `예`. Current enabled settings are 민법총칙 `^(제01장|제02장|제03장)` × 3 and 물권법 `^(제14장|제15장)` × 7. Other settings are disabled. The total is capped at 40.
- Each scope is evaluated separately through `GPT브리지_1차!B7:B10` as `범위지정`, scope regex, count, derived seed. The derived seed is `((baseSeed + scopeIndex * 104729) % 2147483646) + 1`. Duplicate stable keys between scopes fail.
- The bridge candidate formula filters `문제원장`: nonblank A; D=`1차 OX`; L=`활성`; Z=`아니오`; X=`있음`. For `취약`, AC=2. For `범위지정`, `REGEXMATCH(Q & " " & F, keyword)`. It sorts ascending by AC priority, then ascending by `MOD(sourceSheetRow * 1103515245 + seed, 2147483647)`, exposes up to 120 candidates, and the script takes the first requested count.

## P2 rule in the independent test Sheet

- `P2F_issue` accepts `전범위`, `범위지정`, or `취약`; range mode requires a keyword. `caseCount` is a **case-group count** (1–20), not a subquestion count.
- `GPT브리지_2차!A17` filters case-group rows AG:AP: group key nonblank; `취약` requires AR=TRUE; `범위지정` searches the keyword in AQ. It sorts ascending by group priority (column 5 of the selected array), then ascending by `MOD(groupTableRow * 1103515245 + seed, 2147483647)`. The script takes the top `caseCount` group keys.
- The selected groups expand to all matching subquestions through `V17:AE`: `문제원장` D=`2차 서술형`, L=`활성`, X=`있음`, AH≠`졸업`; group key strips the `-소문항N` suffix. Expanded items sort by selected-group order and stable key. The complete group is issued.

## Current PostgreSQL gap

`db/postgres-adapter.mjs` currently selects verified, active encrypted grading keys and published problems, then filters by broad `ILIKE` over prompt/JSON metadata and sorts `md5(stable_key || requestId)`. It does not apply P1 enabled scope quotas, priority, Sheet row seed order or mode semantics. P2 limits individual problems, not groups. `selection_metadata` is unconstrained JSON and the Docs snapshot starts it as `{}`. The source-row, priority, group-table row, weak flag, search text, and retirement status required by the formulas are not guaranteed to be present. Existing PostgreSQL candidate parity is therefore **unverified and presently non-equivalent**.

## Read-only database inventory query

Run only with a read-only connection and without selecting prompts, answers, ciphertext, or credentials. JSON key names below are proposed metadata names; inspect actual key frequency before adopting them.

```sql
BEGIN READ ONLY;
SELECT stage, count(*) AS problems,
       count(*) FILTER (WHERE selection_metadata = '{}'::jsonb) AS empty_metadata,
       count(*) FILTER (WHERE selection_metadata ? 'source_row') AS with_source_row,
       count(*) FILTER (WHERE selection_metadata ? 'priority') AS with_priority,
       count(*) FILTER (WHERE selection_metadata ? 'group_key') AS with_group_key,
       count(*) FILTER (WHERE selection_metadata ? 'group_row') AS with_group_row,
       count(*) FILTER (WHERE selection_metadata ? 'weak') AS with_weak
FROM problems WHERE subject_id='CIVIL' AND published=true GROUP BY stage ORDER BY stage;
SELECT stage, key, count(*) AS rows
FROM problems p CROSS JOIN LATERAL jsonb_object_keys(p.selection_metadata) AS key
WHERE p.subject_id='CIVIL' AND p.published=true
GROUP BY stage, key ORDER BY stage, rows DESC, key;
COMMIT;
```

## Safe remediation gates

1. Capture source Sheet configuration and formula contracts as versioned, non-secret fixtures. Capture only stable keys and selection metadata for deterministic test vectors, with source row/order and seed. Sheet state changes as history grows, so fixtures require a timestamp and state fingerprint.
2. Read-only compare the DB metadata inventory with the Sheet's P1 source columns A/D/F/L/Q/X/Z/AC and P2 source/group columns, preserving stable keys and source order. Populate missing metadata only in the independent test DB through a reviewed migration; retain older problem versions and attempt history.
3. Reuse the existing transactional issue/grade path. Replace only candidate selection to match P1 scope quotas and P2 group expansion. Fail closed when requisite metadata or verified grading keys are missing; never use a fallback random selection.
4. Test fixed-seed candidate keys against Sheet formula fixtures for each P1 scope and P2 mode, including weak/range, duplicates, retired items, and multi-subquestion cases. Compare historical answer/score/attempt counts and digests separately; the current `verify-live-readonly.mjs` checks DB internal counts, not Sheet-to-DB history equality.
5. Keep the operating Sheets read-only. Do not approve production cutover until selection vectors, history parity, duplicate/retry/rollback and isolated restore gates pass. The prior PITR drill supports DB restore integrity, but does not establish Sheet selection or history parity.
