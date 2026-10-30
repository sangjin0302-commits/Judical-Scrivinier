import { createHash } from "node:crypto";

const MODES = new Set(["전범위", "범위지정", "취약", "문제지정", "미풀이", "오답",
  "낮은점수", "복습대상", "원문변경"]);
const SUBJECT = "CIVIL";

function options(input) {
  const stage = input.stage;
  if (stage !== "P1" && stage !== "P2") throw new Error("invalid exam stage");
  const mode = input.mode || "전범위";
  if (!MODES.has(mode)) throw new Error("invalid issue mode");
  const keyword = String(input.keyword || "").trim();
  if (mode === "범위지정" && (!keyword || keyword.length > 100)) throw new Error("range keyword required");
  const questionType = String(input.questionType || "").trim();
  if (questionType.length > 100) throw new Error("invalid question type");
  const lowScoreBelow = input.lowScoreBelow == null ? null : Number(input.lowScoreBelow);
  if (mode === "낮은점수" && (lowScoreBelow == null || !Number.isFinite(lowScoreBelow) ||
      lowScoreBelow <= 0 || lowScoreBelow > 1)) throw new Error("low-score threshold required");
  const exact = [input.year, input.session, input.questionNumber].map((part) => part == null ? "" : String(part).trim());
  if (exact[0] && !/^[0-9]{4}$/.test(exact[0])) throw new Error("invalid exam year");
  if (exact[1] && !/^[1-9][0-9]{0,2}$/.test(exact[1])) throw new Error("invalid exam session");
  if (exact[2] && !/^[1-9][0-9]{0,2}$/.test(exact[2])) throw new Error("invalid question number");
  const rawKeys = input.specificKeys;
  if (rawKeys != null && (!Array.isArray(rawKeys) || rawKeys.length < 1 || rawKeys.length > 40)) {
    throw new Error("invalid specific keys");
  }
  if (mode === "문제지정" ? !rawKeys : rawKeys != null) {
    throw new Error("specific keys require explicit issue mode");
  }
  const specificKeys = rawKeys?.map((key) => String(key).trim());
  if (specificKeys?.some((key) => !key || key.length > 250)) throw new Error("invalid specific key");
  const normalizedKeys = stage === "P2" && specificKeys
    ? specificKeys.map((key) => key.replace(/-소문항[0-9]+$/u, "")) : specificKeys;
  if (normalizedKeys && new Set(normalizedKeys).size !== normalizedKeys.length) {
    throw new Error("duplicate specific keys");
  }
  const count = stage === "P1" ? Number(input.count ?? specificKeys?.length ?? 10) : 0;
  if (stage === "P1" && (!Number.isInteger(count) || count < 1 || count > 40)) {
    throw new Error("invalid P1 count");
  }
  if (stage === "P1" && specificKeys && specificKeys.length !== count) {
    throw new Error("specific P1 key count mismatch");
  }
  const caseCount = stage === "P2" ? Number(input.caseCount ?? normalizedKeys?.length ?? 1) : 0;
  if (stage === "P2" && (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 20)) {
    throw new Error("invalid case count");
  }
  if (stage === "P2" && normalizedKeys && normalizedKeys.length !== caseCount) {
    throw new Error("specific P2 case count mismatch");
  }
  if (!input.ownerId || !input.requestId || !input.keyId) throw new Error("selection identity missing");
  return { stage, mode, keyword, questionType, count, caseCount, specificKeys: normalizedKeys,
    exact, lowScoreBelow };
}

const p1LatestWrong = `COALESCE((SELECT NOT g.is_correct
  FROM p1_grades g JOIN submissions s ON s.submission_id=g.submission_id
   WHERE g.subject_id=p.subject_id AND g.stable_key=p.stable_key
     AND s.owner_id=$2 AND s.state='COMMITTED'
   ORDER BY s.committed_at DESC NULLS LAST,s.created_at DESC LIMIT 1),false)`;
// Legacy partial submissions may have zero-point grade rows for omitted items.
// Only a preserved, nonempty original constitutes an attempted subquestion.
const submittedP2 = `EXISTS (SELECT 1 FROM original_answers oa
      WHERE oa.submission_id=g.submission_id AND oa.subject_id=g.subject_id
        AND oa.stable_key=g.stable_key AND length(btrim(oa.answer_text))>0)`;
const p2LatestRatio = `(SELECT g.awarded_points/g.max_points
  FROM p2_grades g JOIN submissions s ON s.submission_id=g.submission_id
   WHERE g.subject_id=p.subject_id AND g.stable_key=p.stable_key
     AND s.owner_id=$2 AND s.state='COMMITTED'
     AND ${submittedP2}
   ORDER BY s.committed_at DESC NULLS LAST,s.created_at DESC LIMIT 1)`;
const activeSet = `EXISTS (
  SELECT 1 FROM issue_set_items active_item JOIN issue_sets active_set ON active_set.set_id=active_item.set_id
   WHERE active_item.subject_id=p.subject_id AND active_item.stable_key=p.stable_key
     AND active_set.owner_id=$2 AND active_set.state='PREPARED')`;
const attempted = (gradeTable) => `EXISTS (
  SELECT 1 FROM ${gradeTable} g JOIN submissions s ON s.submission_id=g.submission_id
   WHERE g.subject_id=p.subject_id AND g.stable_key=p.stable_key
     AND s.owner_id=$2 AND s.state='COMMITTED'
     ${gradeTable === "p2_grades" ? `AND ${submittedP2}` : ""})`;
const sourceChanged = `EXISTS (
  SELECT 1 FROM issue_set_items old_item JOIN issue_sets old_set ON old_set.set_id=old_item.set_id
  JOIN submissions old_submission ON old_submission.set_id=old_set.set_id
   WHERE old_item.subject_id=p.subject_id AND old_item.stable_key=p.stable_key
     AND old_set.owner_id=$2 AND old_submission.owner_id=$2
     AND old_submission.state='COMMITTED'
     AND old_item.problem_version_id IS DISTINCT FROM p.current_problem_version_id)`;
const due = `EXISTS (
  SELECT 1 FROM exam_review_due due_item WHERE due_item.subject_id=p.subject_id
    AND due_item.stable_key=p.stable_key AND due_item.owner_id=$2 AND due_item.due_at<=now())`;

function historyFilter(stage, mode) {
  if (mode === "취약" || mode === "오답") return stage === "P1" ? p1LatestWrong
    : `COALESCE(${p2LatestRatio}<1,false)`;
  if (mode === "미풀이") return `NOT ${attempted(stage === "P1" ? "p1_grades" : "p2_grades")}`;
  if (mode === "낮은점수") return stage === "P1"
    ? `$11::numeric>0 AND ${p1LatestWrong}`
    : `COALESCE(${p2LatestRatio}<$11::numeric,false)`;
  if (mode === "복습대상") return due;
  if (mode === "원문변경") return sourceChanged;
  return null;
}

const keyJoin = `JOIN LATERAL (
  SELECT key_version,encryption_key_id FROM private_grading_keys key_candidate
   WHERE key_candidate.subject_id=p.subject_id AND key_candidate.stable_key=p.stable_key
     AND key_candidate.verification_state='verified' AND key_candidate.active_for_grading=true
     AND key_candidate.encryption_key_id=$3
   ORDER BY key_candidate.created_at DESC,key_candidate.key_version DESC LIMIT 1
) k ON true`;
const fields = `p.stable_key,p.prompt_text,p.max_points,p.source_version,p.selection_metadata,
  p.current_problem_version_id AS problem_version_id,
  k.key_version AS grading_key_version,k.encryption_key_id AS grading_encryption_key_id`;

async function selectP1(client, { mode, keyword, questionType, count, specificKeys, exact, lowScoreBelow }, input) {
  const exactFilter = `AND ($8::text='' OR p.selection_metadata->>'year'=$8)
    AND ($9::text='' OR p.selection_metadata->>'session'=$9)
    AND ($10::text='' OR p.selection_metadata->>'questionNumber'=$10)
    AND ($12::text='' OR p.selection_metadata->>'type'=$12
      OR p.selection_metadata->>'detailType'=$12)`;
  const filter = mode === "범위지정"
    ? "AND (position(lower($4) in lower(p.prompt_text))>0 OR position(lower($4) in lower(coalesce(p.selection_metadata->>'scope','')))>0)"
    : historyFilter("P1", mode) ? `AND ${historyFilter("P1", mode)}` : "";
  const params = [SUBJECT, input.ownerId, input.keyId, keyword, 0, count,
    specificKeys || [], ...exact, lowScoreBelow ?? 0, questionType];
  if (mode === "문제지정") {
    const result = await client.query(
      `SELECT ${fields} FROM problems p ${keyJoin}
        WHERE p.subject_id=$1 AND p.stage='P1' AND p.published=true
          AND p.current_problem_version_id IS NOT NULL
          AND $2::text IS NOT NULL AND $4::text IS NOT NULL
          AND $5::bigint IS NOT NULL AND $6::int IS NOT NULL AND $11::numeric IS NOT NULL
          AND p.stable_key=ANY($7::text[])
          AND NOT ${activeSet} ${exactFilter}
        ORDER BY array_position($7::text[],p.stable_key)`,
      params);
    if (result.rowCount !== count) throw new Error("specific P1 problem missing or ineligible");
    return result.rows;
  }
  const seed = createHash("sha256").update(JSON.stringify([input.ownerId, input.requestId])).digest().readUInt32BE(0);
  params[4] = seed;
  const result = await client.query(
    `WITH pivot AS (
       SELECT ($5::bigint % GREATEST(COALESCE((
         SELECT source_order FROM problems
          WHERE subject_id=$1 AND stage='P1' AND published=true
          ORDER BY source_order DESC LIMIT 1),1),1)) + 1 AS source_order
     ), upper_candidates AS MATERIALIZED (
       SELECT 0 AS segment,p.source_order,${fields} FROM problems p ${keyJoin}
        WHERE p.subject_id=$1 AND p.stage='P1' AND p.published=true
          AND p.current_problem_version_id IS NOT NULL
          AND $2::text IS NOT NULL AND $4::text IS NOT NULL AND $7::text[] IS NOT NULL
          AND $11::numeric IS NOT NULL
          AND NOT ${activeSet} ${exactFilter}
          AND p.source_order >= (SELECT source_order FROM pivot) ${filter}
        ORDER BY p.source_order,p.stable_key LIMIT $6
     ), lower_candidates AS MATERIALIZED (
       SELECT 1 AS segment,p.source_order,${fields} FROM problems p ${keyJoin}
        WHERE p.subject_id=$1 AND p.stage='P1' AND p.published=true
          AND p.current_problem_version_id IS NOT NULL
          AND $2::text IS NOT NULL AND $4::text IS NOT NULL AND $7::text[] IS NOT NULL
          AND $11::numeric IS NOT NULL
          AND NOT ${activeSet} ${exactFilter}
          AND p.source_order < (SELECT source_order FROM pivot) ${filter}
          AND (SELECT count(*) FROM upper_candidates) < $6
        ORDER BY p.source_order,p.stable_key
        LIMIT ($6 - (SELECT count(*) FROM upper_candidates))
     )
     SELECT stable_key,prompt_text,max_points,source_version,selection_metadata,problem_version_id,
            grading_key_version,grading_encryption_key_id
       FROM (SELECT * FROM upper_candidates UNION ALL SELECT * FROM lower_candidates) picked
      ORDER BY segment,source_order,stable_key LIMIT $6`,
    params);
  const rows = result.rows;
  if (rows.length !== count || new Set(rows.map((row) => row.stable_key)).size !== count) {
    throw new Error("not enough eligible P1 problems");
  }
  return rows;
}

async function selectP2(client, { mode, keyword, questionType, caseCount, specificKeys,
  exact, lowScoreBelow }, input) {
  const groupKey = "regexp_replace(p.stable_key,'-소문항[0-9]+$','')";
  const range = "bool_or(position(lower($4) in lower(p.prompt_text))>0 OR position(lower($4) in lower(coalesce(p.selection_metadata->>'scope','')))>0)";
  const history = historyFilter("P2", mode);
  const historyClause = history ? `AND ${mode === "미풀이" ? "bool_and" : "bool_or"}(${history})` : "";
  const modeFilter = mode === "범위지정" ? `AND ${range}`
    : mode === "문제지정" ? `AND ${groupKey}=ANY($7::text[])` : historyClause;
  const exactFilter = `AND ($8::text='' OR split_part(split_part(${groupKey},'|',2),'-',1)=$8)
    AND ($9::text='' OR substring(${groupKey} from '-제([0-9]+)회-')=$9)
    AND ($10::text='' OR substring(${groupKey} from '-문([0-9]+)$')=$10)
    AND ($12::text='' OR bool_or(p.selection_metadata->>'type'=$12
      OR p.selection_metadata->>'detailType'=$12))`;
  const order = mode === "문제지정" ? `array_position($7::text[],${groupKey})`
    : `md5(${groupKey} || $5),${groupKey}`;
  const rankOrder = mode === "문제지정" ? "array_position($7::text[],group_key)"
    : "md5(group_key || $5),group_key";
  const result = await client.query(
    `WITH eligible_groups AS (
       SELECT ${groupKey} AS group_key
         FROM problems p
        WHERE p.subject_id=$1 AND p.stage='P2' AND p.stable_key ~ '-소문항[0-9]+$'
          AND $2::text IS NOT NULL AND $4::text IS NOT NULL
          AND $5::text IS NOT NULL AND $7::text[] IS NOT NULL AND $11::numeric IS NOT NULL
        GROUP BY ${groupKey}
       HAVING bool_and(p.published AND p.current_problem_version_id IS NOT NULL AND NOT ${activeSet} AND EXISTS (
         SELECT 1 FROM private_grading_keys key_check
          WHERE key_check.subject_id=p.subject_id AND key_check.stable_key=p.stable_key
            AND key_check.verification_state='verified'
            AND key_check.active_for_grading=true AND key_check.encryption_key_id=$3))
              ${modeFilter} ${exactFilter}
        ORDER BY ${order} LIMIT $6
     ), numbered_groups AS (
       SELECT group_key,row_number() OVER (ORDER BY ${rankOrder}) AS group_position
         FROM eligible_groups
     )
     SELECT ${fields},g.group_key,g.group_position
       FROM numbered_groups g JOIN problems p
         ON p.subject_id=$1 AND p.stage='P2'
        AND p.stable_key ~ '-소문항[0-9]+$'
        AND ${groupKey}=g.group_key
       ${keyJoin}
      ORDER BY g.group_position,p.source_order,p.stable_key`,
    [SUBJECT, input.ownerId, input.keyId, keyword,
      createHash("sha256").update(JSON.stringify([input.ownerId, input.requestId])).digest("hex"),
      caseCount, specificKeys || [], ...exact, lowScoreBelow ?? 0, questionType]);
  const groups = new Set(result.rows.map((row) => row.group_key));
  if (groups.size !== caseCount || result.rows.length === 0) throw new Error("not enough eligible P2 cases");
  return result.rows;
}

/** Called inside the issue-set transaction. Returns only bounded selected problems. */
export async function selectExamCandidates(client, input) {
  const parsed = options(input);
  return parsed.stage === "P1" ? selectP1(client, parsed, input) : selectP2(client, parsed, input);
}
