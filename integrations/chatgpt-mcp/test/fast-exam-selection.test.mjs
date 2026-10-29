import assert from "node:assert/strict";
import test from "node:test";

import { selectExamCandidates } from "../db/fast-exam-selection.mjs";

const base = { ownerId: "owner-1", requestId: "request-1", keyId: "key-v2" };
const problem = (number) => ({ stable_key: `SRC-CIV-004|P${number}`, prompt_text: `Q${number}`,
  source_version: "v1", problem_version_id: `version-${number}`,
  grading_key_version: "v1", grading_encryption_key_id: "key-v2" });

test("P1 selects ten unique key-verified rows in one indexed pivot-wrap statement", async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    const rows = Array.from({ length: 10 }, (_, i) => problem(i + 1));
    return { rows, rowCount: rows.length };
  } };
  const rows = await selectExamCandidates(client, { ...base, stage: "P1", mode: "전범위" });
  assert.equal(rows.length, 10);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WITH pivot AS/);
  assert.match(calls[0].sql, /upper_candidates AS MATERIALIZED/);
  assert.match(calls[0].sql, /lower_candidates AS MATERIALIZED/);
  assert.match(calls[0].sql, /active_for_grading=true/);
  assert.match(calls[0].sql, /ORDER BY segment,source_order,stable_key LIMIT \$6/);
  assert.match(calls[0].sql, /SELECT stable_key,prompt_text,max_points,source_version,selection_metadata,problem_version_id/);
  assert.ok(rows.every((row) => row.problem_version_id));
  assert.equal(calls[0].params[5], 10);
});

test("P1 rejects incomplete or duplicate candidate set", async () => {
  const client = { async query(sql) {
    if (sql.includes("max(source_order)")) return { rows: [{ max_order: 20 }] };
    return { rows: Array.from({ length: 9 }, (_, i) => problem(i + 1)), rowCount: 9 };
  } };
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1" }), /not enough eligible P1/);
  const duplicateClient = { async query(sql) {
    if (sql.includes("max(source_order)")) return { rows: [{ max_order: 20 }] };
    const rows = Array.from({ length: 10 }, (_, i) => problem(i === 9 ? 1 : i + 1));
    return { rows, rowCount: rows.length };
  } };
  await assert.rejects(selectExamCandidates(duplicateClient, { ...base, stage: "P1" }),
    /not enough eligible P1/);
});

test("P1 respects requested count up to forty", async () => {
  const client = { async query(sql, params) {
    if (sql.includes("max(source_order)")) return { rows: [{ max_order: 100 }] };
    const rows = Array.from({ length: params[5] }, (_, i) => problem(i + 1));
    return { rows, rowCount: rows.length };
  } };
  assert.equal((await selectExamCandidates(client, { ...base, stage: "P1", count: 40 })).length, 40);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1", count: 41 }), /invalid P1 count/);
});

test("P1 exact stable keys preserve request order and fail when any key lacks active grading", async () => {
  const keys = ["SRC-CIV-004|P8", "SRC-CIV-004|P2"];
  let eligible = true;
  const client = { async query(sql, params) {
    assert.match(sql, /p.stable_key=ANY\(\$7::text\[\]\)/);
    assert.match(sql, /array_position\(\$7::text\[\],p.stable_key\)/);
    assert.deepEqual(params[6], keys);
    const rows = eligible ? [problem(8), problem(2)] : [problem(8)];
    return { rows, rowCount: rows.length };
  } };
  const selected = await selectExamCandidates(client, { ...base, stage: "P1",
    mode: "문제지정", specificKeys: keys });
  assert.deepEqual(selected.map((row) => row.stable_key), keys);
  eligible = false;
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1",
    mode: "문제지정", specificKeys: keys }), /specific P1 problem missing/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1",
    mode: "문제지정", specificKeys: keys, count: 1 }), /specific P1 key count mismatch/);
});

test("P1 range and weak modes filter from real prompt or owner history", async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes("max(source_order)")) return { rows: [{ max_order: 100 }] };
    return { rows: Array.from({ length: 10 }, (_, i) => problem(i + 1)), rowCount: 10 };
  } };
  await selectExamCandidates(client, { ...base, stage: "P1", mode: "범위지정", keyword: "물권" });
  assert.match(statements[0], /position\(lower\(\$4\) in lower\(p.prompt_text\)\)/);
  await selectExamCandidates(client, { ...base, stage: "P1", mode: "취약" });
  assert.match(statements.at(-1), /JOIN submissions s/);
  assert.match(statements.at(-1), /SELECT NOT g.is_correct/);
  assert.match(statements.at(-1), /ORDER BY s.committed_at DESC NULLS LAST/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1", mode: "범위지정" }),
    /range keyword required/);
});

test("P2 returns every item from complete verified case groups", async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [
      { ...problem(1), group_key: "case-A", group_position: 1 },
      { ...problem(2), group_key: "case-A", group_position: 1 },
      { ...problem(3), group_key: "case-B", group_position: 2 },
    ] };
  } };
  const rows = await selectExamCandidates(client, { ...base, stage: "P2", caseCount: 2 });
  assert.equal(rows.length, 3);
  assert.match(calls[0].sql, /-소문항\[0-9\]\+\$/);
  assert.match(calls[0].sql, /bool_and\(p.published AND p.current_problem_version_id IS NOT NULL AND NOT EXISTS/);
  assert.match(calls[0].sql, /JOIN LATERAL/);
  assert.match(calls[0].sql, /ORDER BY key_candidate.created_at DESC,key_candidate.key_version DESC LIMIT 1/);
  assert.equal(calls[0].params[5], 2);
});

test("P2 weak mode uses past partial grades; incomplete cases fail closed", async () => {
  let statement = "";
  const client = { async query(sql) {
    statement = sql;
    return { rows: [{ ...problem(1), group_key: "case-A", group_position: 1 }] };
  } };
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P2", caseCount: 2, mode: "취약" }),
    /not enough eligible P2/);
  assert.match(statement, /g.awarded_points\/g.max_points/);
  assert.match(statement, /LIMIT 1\)<1,false/);
  assert.match(statement, /s.owner_id=\$2/);
});

test("P2 exact subquestion key expands its full case and fails missing group", async () => {
  const group = "SRC-CIV-005|2025-제1회-문2";
  let available = true;
  const client = { async query(sql, params) {
    assert.match(sql, /array_position\(\$7::text\[\],group_key\)/);
    assert.deepEqual(params[6], [group]);
    return { rows: available ? [
      { ...problem(1), group_key: group }, { ...problem(2), group_key: group },
    ] : [] };
  } };
  const result = await selectExamCandidates(client, { ...base, stage: "P2",
    mode: "문제지정", specificKeys: [group + "-소문항1"] });
  assert.equal(result.length, 2);
  available = false;
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P2",
    mode: "문제지정", specificKeys: [group] }), /not enough eligible P2 cases/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P2",
    mode: "문제지정", specificKeys: [group, group + "-소문항2"] }), /duplicate specific keys/);
});

test("exact mode requires explicit bounded specific keys", async () => {
  const client = { async query() { throw new Error("must not query"); } };
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1", mode: "문제지정" }),
    /specific keys require explicit issue mode/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1",
    specificKeys: ["SRC-CIV-004|P1"] }), /specific keys require explicit issue mode/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1", mode: "문제지정",
    specificKeys: ["SRC-CIV-004|P1", "SRC-CIV-004|P1"] }), /duplicate specific keys/);
});

test("P1 exam metadata, active-set dedup and study-history modes stay parameterized", async () => {
  const seen = [];
  const client = { async query(sql, params) {
    seen.push({ sql, params });
    const rows = Array.from({ length: 10 }, (_, i) => problem(i + 1));
    return { rows, rowCount: 10 };
  } };
  for (const mode of ["미풀이", "오답", "낮은점수", "복습대상", "원문변경"]) {
    await selectExamCandidates(client, { ...base, stage: "P1", mode,
      lowScoreBelow: mode === "낮은점수" ? 0.5 : undefined,
      questionType: "판례형", year: "2025", session: 2, questionNumber: 3 });
  }
  assert.equal(seen.length, 5);
  assert.ok(seen.every(({ sql, params }) => sql.includes("active_set.state='PREPARED'") &&
    params[7] === "2025" && params[8] === "2" && params[9] === "3" && params[11] === "판례형"));
  assert.match(seen[0].sql, /NOT EXISTS \(\s*SELECT 1 FROM p1_grades/);
  assert.match(seen[1].sql, /SELECT NOT g.is_correct/);
  assert.match(seen[2].sql, /\$11::numeric>0/);
  assert.match(seen[3].sql, /exam_review_due/);
  assert.match(seen[4].sql, /old_item.problem_version_id IS DISTINCT FROM p.current_problem_version_id/);
  await assert.rejects(selectExamCandidates(client, { ...base, stage: "P1",
    mode: "낮은점수" }), /low-score threshold required/);
});

test("P2 exact year/session/question and type filter preserve group completeness", async () => {
  let statement = "";
  const client = { async query(sql, params) {
    statement = sql;
    assert.deepEqual(params.slice(7, 10), ["2025", "2", "3"]);
    assert.equal(params[11], "사례형");
    return { rows: [{ ...problem(1), group_key: "SRC-CIV-005|2025-제2회-문3" }] };
  } };
  await selectExamCandidates(client, { ...base, stage: "P2", year: 2025,
    session: 2, questionNumber: 3, questionType: "사례형" });
  assert.match(statement, /split_part\(split_part\(regexp_replace/);
  assert.match(statement, /substring\(regexp_replace/);
  assert.match(statement, /bool_or\(p.selection_metadata->>'type'=\$12/);
  assert.match(statement, /active_set.state='PREPARED'/);
});

test("P2 history modes filter whole groups without dropping subquestions", async () => {
  const seen = [];
  const client = { async query(sql, params) {
    seen.push({ sql, params });
    return { rows: [{ ...problem(1), group_key: "case-A" }] };
  } };
  for (const mode of ["미풀이", "오답", "낮은점수", "복습대상", "원문변경"]) {
    await selectExamCandidates(client, { ...base, stage: "P2", mode,
      lowScoreBelow: mode === "낮은점수" ? 0.6 : undefined });
  }
  assert.match(seen[0].sql, /AND bool_and\(NOT EXISTS/);
  assert.match(seen[1].sql, /AND bool_or\(COALESCE/);
  assert.match(seen[2].sql, /g.awarded_points\/g.max_points/);
  assert.match(seen[2].sql, /LIMIT 1\)<\$11::numeric,false/);
  assert.equal(seen[2].params[10], 0.6);
  assert.match(seen[3].sql, /exam_review_due/);
  assert.match(seen[4].sql, /old_item.problem_version_id IS DISTINCT FROM p.current_problem_version_id/);
  assert.ok(seen.every(({ sql }) => sql.includes("bool_and(p.published") &&
    sql.includes("active_set.state='PREPARED'")));
});
