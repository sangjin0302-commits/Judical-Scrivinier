// Read-only, owner-scoped exam progress. Never joins private grading keys or original answers.
const PASS_RATE = .667;
const DAY = 86400000;

function dateMs(value) {
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}

function asRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function summarizeExamProblem(problem, attempts, { now = new Date() } = {}) {
  const sorted = [...attempts].sort((a, b) => (dateMs(a.at) ?? 0) - (dateMs(b.at) ?? 0) || String(a.id).localeCompare(String(b.id)));
  const latest = sorted.at(-1);
  const latestRate = latest ? asRate(latest.rate) : null;
  const ambiguous = sorted.some(a => a.ambiguous || asRate(a.rate) === null || dateMs(a.at) === null);
  const result = {
    stableKey: problem.stable_key,
    stage: problem.stage,
    attempts: sorted.some(a => a.uncertainDuplicate) ? null : sorted.length,
    latestScoreRate: ambiguous ? null : latestRate,
    lastAttemptAt: ambiguous ? null : latest?.at ?? null,
    pass: null,
    graduated: null,
    mastery: ambiguous ? "미확인" : "미풀이",
    reviewDueAt: null,
    historyStatus: ambiguous ? "ambiguous" : "verified",
  };
  if (!latest || ambiguous) return result;
  const interval = sorted.length === 1 ? 7 : sorted.length === 2 ? 21 : 60;
  result.reviewDueAt = new Date(dateMs(latest.at) + interval * DAY).toISOString();
  if (problem.stage === "P1") {
    result.pass = latestRate >= PASS_RATE;
    result.mastery = result.pass ? "통과" : "재출제";
    return result;
  }
  // Seven diagnostic values remain separate from official point score.
  let acceptedA = 0;
  let previousA = null;
  for (const a of sorted) {
    const seven = a.seven;
    if (!Array.isArray(seven) || seven.length !== 7 || seven.some(n => !Number.isInteger(n) || n < 0 || n > 2)) {
      result.historyStatus = "ambiguous";
      result.mastery = "미확인";
      return result;
    }
    const structure = seven.reduce((x, y) => x + y, 0) / 14;
    const rate = asRate(a.rate);
    const grade = structure >= .85 && rate >= PASS_RATE && Math.min(...seven) > 0 ? "A"
      : structure >= .7 && rate >= PASS_RATE ? "B" : structure >= .5 ? "C" : "D";
    a.computedGrade = grade;
    const at = dateMs(a.at);
    if (grade === "A") {
      if (previousA === null || at - previousA > 3 * DAY) acceptedA++;
      previousA = at;
    }
  }
  result.latestDiagnosticGrade = sorted.at(-1).computedGrade;
  result.acceptedA = acceptedA;
  result.pass = acceptedA >= 2;
  result.graduated = acceptedA >= 3;
  result.mastery = result.graduated ? "졸업" : result.pass ? "통과" : "진행";
  return result;
}

function nativeAttempt(row) {
  return {
    id: `native:${row.submission_id}`,
    at: row.committed_at,
    rate: row.stage === "P1" ? (row.is_correct ? 1 : 0) : Number(row.awarded_points) / Number(row.max_points),
    seven: row.stage === "P2" ? [row.issue_score,row.outline_score,row.law_score,row.precedent_score,row.application_score,row.conclusion_score,row.expression_score].map(Number) : undefined,
    setId: row.set_id,
  };
}

function importedAttempt(row, nativeSetIds) {
  const p = row.payload || {};
  if (p.setId && nativeSetIds.has(p.setId)) return null;
  const score = Number(p.score);
  const max = Number(p.maxPoints);
  const valid = p.validState === "유효" || p.validState === "VALID";
  if (!valid) return null;
  return {
    id: `import:${row.event_id}`,
    at: row.created_at,
    rate: max > 0 ? score / max : null,
    // Import event time is migration time, not the original attempt date.
    // Imported 2차 history also lacks seven-element diagnostics.
    ambiguous: true,
    uncertainDuplicate: !p.setId && nativeSetIds.size > 0,
  };
}

export async function getExamProgress(pool, { ownerId, subjectId = "CIVIL", stage, cursor, limit = 50, now = new Date() } = {}) {
  if (typeof ownerId !== "string" || !ownerId.trim()) throw new Error("authenticated owner required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100");
  if (stage !== undefined && !["P1", "P2"].includes(stage)) throw new Error("invalid stage");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 300)) throw new Error("invalid cursor");
  const [problems, totals] = await Promise.all([
    pool.query(`SELECT stable_key, stage FROM problems WHERE subject_id=$1 AND published=true
      AND ($2::text IS NULL OR stage::text=$2) AND stable_key>$3 ORDER BY stable_key LIMIT $4`,
      [subjectId, stage ?? null, cursor ?? "", limit + 1]),
    pool.query(`WITH native AS (
        SELECT g.stable_key,s.set_id FROM p1_grades g
        JOIN submissions s ON s.submission_id=g.submission_id
        WHERE s.owner_id=$1 AND s.subject_id=$2 AND s.state='COMMITTED'
        UNION ALL
        SELECT g.stable_key,s.set_id FROM p2_grades g
        JOIN submissions s ON s.submission_id=g.submission_id
        WHERE s.owner_id=$1 AND s.subject_id=$2 AND s.state='COMMITTED'
          AND EXISTS (SELECT 1 FROM original_answers oa
            WHERE oa.submission_id=g.submission_id AND oa.subject_id=g.subject_id
              AND oa.stable_key=g.stable_key AND length(btrim(oa.answer_text))>0)
      ), unresolved_import AS (
        SELECT DISTINCT e.stable_key FROM learning_events e
        WHERE e.owner_id=$1 AND e.subject_id=$2 AND e.event_type='SHEET_HISTORY_IMPORTED'
          AND e.payload->>'validState' IN ('유효','VALID')
          AND NOT EXISTS (SELECT 1 FROM native n WHERE n.stable_key=e.stable_key
            AND n.set_id=e.payload->>'setId')
      ), problem_state AS (
        SELECT p.stage,
          CASE WHEN i.stable_key IS NOT NULL THEN 'unknown'
               WHEN EXISTS (SELECT 1 FROM native n WHERE n.stable_key=p.stable_key) THEN 'completed'
               ELSE 'unattempted' END AS progress_state
        FROM problems p LEFT JOIN unresolved_import i ON i.stable_key=p.stable_key
        WHERE p.subject_id=$2 AND p.published=true AND ($3::text IS NULL OR p.stage::text=$3)
      )
      SELECT stage,count(*)::int AS total,
        count(*) FILTER (WHERE progress_state='completed')::int AS completed,
        count(*) FILTER (WHERE progress_state='unattempted')::int AS unattempted,
        count(*) FILTER (WHERE progress_state='unknown')::int AS unknown
      FROM problem_state GROUP BY stage`, [ownerId, subjectId, stage ?? null]),
  ]);
  const page = problems.rows.slice(0, limit);
  const overallStatus = totals.rows.some(row => Number(row.unknown) > 0) ? "partial" : "verified";
  if (!page.length) return { items: [], nextCursor: null, totals: totals.rows, overallStatus };
  const keys = page.map(p => p.stable_key);
  const [native, imported] = await Promise.all([
    pool.query(`SELECT s.submission_id,s.set_id,s.committed_at,g.stable_key,'P1' AS stage,g.is_correct,
      NULL::numeric AS awarded_points,NULL::numeric AS max_points,
      NULL::smallint AS issue_score,NULL::smallint AS outline_score,NULL::smallint AS law_score,
      NULL::smallint AS precedent_score,NULL::smallint AS application_score,NULL::smallint AS conclusion_score,NULL::smallint AS expression_score
      FROM p1_grades g JOIN submissions s ON s.submission_id=g.submission_id
      WHERE s.owner_id=$1 AND s.subject_id=$2 AND s.state='COMMITTED' AND g.stable_key=ANY($3::text[])
      UNION ALL
      SELECT s.submission_id,s.set_id,s.committed_at,g.stable_key,'P2',NULL::boolean,g.awarded_points,g.max_points,
      g.issue_score,g.outline_score,g.law_score,g.precedent_score,g.application_score,g.conclusion_score,g.expression_score
      FROM p2_grades g JOIN submissions s ON s.submission_id=g.submission_id
      WHERE s.owner_id=$1 AND s.subject_id=$2 AND s.state='COMMITTED' AND g.stable_key=ANY($3::text[])
      AND EXISTS (SELECT 1 FROM original_answers oa
        WHERE oa.submission_id=g.submission_id AND oa.subject_id=g.subject_id
          AND oa.stable_key=g.stable_key AND length(btrim(oa.answer_text))>0)`,
      [ownerId, subjectId, keys]),
    pool.query(`SELECT e.event_id,e.stable_key,e.created_at,e.payload,p.stage
      FROM learning_events e JOIN problems p ON p.subject_id=e.subject_id AND p.stable_key=e.stable_key
      WHERE e.owner_id=$1 AND e.subject_id=$2 AND e.event_type='SHEET_HISTORY_IMPORTED'
      AND e.stable_key=ANY($3::text[])`, [ownerId, subjectId, keys]),
  ]);
  const byKey = new Map(keys.map(k => [k, []]));
  const nativeSets = new Map(keys.map(k => [k, new Set()]));
  for (const row of native.rows) {
    byKey.get(row.stable_key)?.push(nativeAttempt(row));
    nativeSets.get(row.stable_key)?.add(row.set_id);
  }
  for (const row of imported.rows) {
    const item = importedAttempt(row, nativeSets.get(row.stable_key) ?? new Set());
    if (item) byKey.get(row.stable_key)?.push(item);
  }
  const items = page.map(p => summarizeExamProblem(p, byKey.get(p.stable_key), { now }));
  return {
    items,
    nextCursor: problems.rows.length > limit ? page.at(-1).stable_key : null,
    totals: totals.rows,
    // Pass/graduation aggregates require resolved imported P2 seven-element history.
    overallStatus,
  };
}
