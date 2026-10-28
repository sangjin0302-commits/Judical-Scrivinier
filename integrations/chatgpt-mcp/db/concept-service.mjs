import crypto from "node:crypto";

import { createPostgresPool } from "./postgres-adapter.mjs";

const SUBJECT = "CIVIL";
const MODES = new Set(["INTEGRATED", "CONCEPT_ONLY", "PROBLEM_ONLY"]);
const RESULTS = new Set(["REMEMBERED", "PARTIAL", "RELEARN"]);
const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
const canonical = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function calculateNextReview(memoryResult, previousRememberedCount, rule, now = new Date()) {
  if (!RESULTS.has(memoryResult)) throw new Error("invalid memory result");
  const payload = rule || { rememberedDays: [1, 7, 21, 60], partialDays: 3, relearnDays: 1 };
  const previous = Math.max(0, Number(previousRememberedCount) || 0);
  let days;
  let rememberedCount;
  if (memoryResult === "REMEMBERED") {
    const intervals = payload.rememberedDays || [1, 7, 21, 60];
    days = Number(intervals[Math.min(previous, intervals.length - 1)]);
    rememberedCount = previous + 1;
  } else {
    days = Number(memoryResult === "PARTIAL" ? payload.partialDays : payload.relearnDays);
    rememberedCount = 0;
  }
  if (!Number.isFinite(days) || days <= 0) throw new Error("invalid review rule");
  return { nextReviewAt: new Date(now.getTime() + days * 86_400_000), rememberedCount, intervalDays: days };
}

async function activeRule(client) {
  const result = await client.query(
    "SELECT rule_version,rule_payload FROM review_rules WHERE subject_id=$1 AND active=true",
    [SUBJECT]);
  if (result.rowCount !== 1) throw new Error("active concept review rule missing");
  return result.rows[0];
}

async function getConceptUnit(pool, ownerId, input) {
  const unitId = required(input.unitId, "unitId");
  const requestedMode = input.mode ? required(input.mode, "mode") : null;
  if (requestedMode && !MODES.has(requestedMode)) throw new Error("invalid study mode");
  const client = await pool.connect();
  try {
    const unit = await client.query(
      `SELECT u.unit_id,u.title,u.learning_order,u.learning_goal,u.curriculum_metadata,u.content_state,
              s.study_mode,p.progress_state,p.review_due_at,p.learning_tier
         FROM units u
         LEFT JOIN learner_study_preferences s ON s.owner_id=$1 AND s.subject_id=u.subject_id
         LEFT JOIN learner_progress p ON p.owner_id=$1 AND p.subject_id=u.subject_id AND p.unit_id=u.unit_id
        WHERE u.subject_id=$2 AND u.unit_id=$3`, [ownerId, SUBJECT, unitId]);
    if (unit.rowCount !== 1) throw new Error("concept unit not found");
    const mode = requestedMode || unit.rows[0].study_mode || "INTEGRATED";
    const includeConcept = mode !== "PROBLEM_ONLY";
    const includeProblems = mode !== "CONCEPT_ONLY";
    const [materials, questions, issues, problems] = await Promise.all([
      includeConcept ? client.query(
        `SELECT material_type,source_path,source_version,content_text,verification_state
           FROM concept_material_versions WHERE subject_id=$1 AND unit_id=$2 AND active=true
          ORDER BY material_type`, [SUBJECT, unitId]) : { rows: [] },
      includeConcept ? client.query(
        `SELECT question_id,question_order,prompt_text,content_state FROM recall_questions
          WHERE subject_id=$1 AND unit_id=$2 ORDER BY question_order`, [SUBJECT, unitId]) : { rows: [] },
      includeConcept ? client.query(
        `SELECT issue_id,issue_name,issue_tier,classification_basis,p1_requirement,p2_requirement
           FROM concept_issues WHERE subject_id=$1 AND unit_id=$2 ORDER BY issue_tier,issue_id`, [SUBJECT, unitId]) : { rows: [] },
      includeProblems ? client.query(
        `SELECT l.stable_key,p.stage,p.source_version,p.prompt_text
           FROM concept_problem_links l JOIN problems p
             ON p.subject_id=l.subject_id AND p.stable_key=l.stable_key
          WHERE l.subject_id=$1 AND l.unit_id=$2 AND l.link_status='verified' AND p.published=true
          ORDER BY p.stage,p.source_order`, [SUBJECT, unitId]) : { rows: [] },
    ]);
    return { ok: true, mode, unit: unit.rows[0], materials: materials.rows,
      recallQuestions: questions.rows, issues: issues.rows, linkedProblems: problems.rows };
  } finally { client.release(); }
}

async function setStudyMode(pool, ownerId, input) {
  const mode = required(input.mode, "mode");
  if (!MODES.has(mode)) throw new Error("invalid study mode");
  return transaction(pool, async (client) => {
    const prior = await client.query(
      "SELECT study_mode FROM learner_study_preferences WHERE owner_id=$1 AND subject_id=$2 FOR UPDATE",
      [ownerId, SUBJECT]);
    const replayed = prior.rows[0]?.study_mode === mode;
    await client.query(
      `INSERT INTO learner_study_preferences(owner_id,subject_id,study_mode) VALUES($1,$2,$3)
       ON CONFLICT(owner_id,subject_id) DO UPDATE SET study_mode=excluded.study_mode,updated_at=now()`,
      [ownerId, SUBJECT, mode]);
    return { ok: true, replayed, mode };
  });
}

async function getDueReviews(pool, ownerId, input) {
  const limit = Math.max(1, Math.min(Number(input.limit || 10), 50));
  const client = await pool.connect();
  try {
    const result = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (a.question_id)
                a.question_id,a.unit_id,a.next_review_at,a.remembered_count
           FROM recall_attempts a
          WHERE a.owner_id=$1 AND a.subject_id=$2
          ORDER BY a.question_id,a.created_at DESC,a.attempt_id DESC
       )
       SELECT l.unit_id,u.title,l.next_review_at AS review_due_at,
              q.question_id,q.prompt_text,q.content_state,l.remembered_count
         FROM latest l
         JOIN units u ON u.subject_id=$2 AND u.unit_id=l.unit_id
         JOIN recall_questions q ON q.subject_id=$2 AND q.question_id=l.question_id
        WHERE l.next_review_at <= now() AND q.prompt_text IS NOT NULL
        ORDER BY l.next_review_at,u.learning_order,q.question_order LIMIT $3`,
      [ownerId, SUBJECT, limit]);
    return { ok: true, count: result.rowCount, reviews: result.rows };
  } finally { client.release(); }
}

async function submitRecall(pool, ownerId, input) {
  const requestId = required(input.requestId, "requestId");
  const questionId = required(input.questionId, "questionId");
  const answerText = required(input.answerText, "answerText");
  const memoryResult = required(input.memoryResult, "memoryResult");
  if (!RESULTS.has(memoryResult)) throw new Error("invalid memory result");
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  const requestDigest = digest({ questionId, answerText, memoryResult, evidence });
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [digest([ownerId, SUBJECT, requestId])]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [digest([ownerId, SUBJECT, questionId])]);
    const prior = await client.query(
      `SELECT attempt_id,question_id,answer_digest,memory_result,evidence_payload,next_review_at
         FROM recall_attempts WHERE owner_id=$1 AND subject_id=$2 AND request_id=$3 FOR UPDATE`,
      [ownerId, SUBJECT, requestId]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      const priorDigest = digest({ questionId: row.question_id, answerTextDigest: row.answer_digest,
        memoryResult: row.memory_result, evidence: row.evidence_payload });
      const incomingDigest = digest({ questionId, answerTextDigest: digest(answerText), memoryResult, evidence });
      if (priorDigest !== incomingDigest) throw new Error("changed recall payload rejected");
      return { ok: true, replayed: true, attemptId: row.attempt_id, nextReviewAt: row.next_review_at };
    }
    const question = await client.query(
      `SELECT unit_id,content_state FROM recall_questions
        WHERE subject_id=$1 AND question_id=$2 AND prompt_text IS NOT NULL FOR SHARE`, [SUBJECT, questionId]);
    if (question.rowCount !== 1) throw new Error("recall question content unavailable");
    const rule = await activeRule(client);
    const progress = await client.query(
      `SELECT learning_tier,progress_state,evidence_digest FROM learner_progress
        WHERE owner_id=$1 AND subject_id=$2 AND unit_id=$3 FOR UPDATE`,
      [ownerId, SUBJECT, question.rows[0].unit_id]);
    const previousAttempt = await client.query(
      `SELECT memory_result,remembered_count FROM recall_attempts
        WHERE owner_id=$1 AND subject_id=$2 AND question_id=$3
        ORDER BY created_at DESC,attempt_id DESC LIMIT 1 FOR SHARE`,
      [ownerId, SUBJECT, questionId]);
    const previousRememberedCount = previousAttempt.rows[0]?.memory_result === "REMEMBERED"
      ? Number(previousAttempt.rows[0].remembered_count) || 0 : 0;
    const schedule = calculateNextReview(memoryResult, previousRememberedCount, rule.rule_payload);
    const inserted = await client.query(
      `INSERT INTO recall_attempts(owner_id,subject_id,unit_id,question_id,request_id,answer_text,answer_digest,
         memory_result,remembered_count,evidence_payload,next_review_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING attempt_id`,
      [ownerId, SUBJECT, question.rows[0].unit_id, questionId, requestId, answerText, digest(answerText),
        memoryResult, schedule.rememberedCount, JSON.stringify(evidence), schedule.nextReviewAt]);
    const unitDue = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (question_id) question_id,next_review_at
           FROM recall_attempts
          WHERE owner_id=$1 AND subject_id=$2 AND unit_id=$3
          ORDER BY question_id,created_at DESC,attempt_id DESC
       ) SELECT min(next_review_at) AS review_due_at FROM latest`,
      [ownerId, SUBJECT, question.rows[0].unit_id]);
    const progressState = memoryResult === "REMEMBERED" ? `REMEMBERED:${schedule.rememberedCount}` : memoryResult;
    await client.query(
      `INSERT INTO learner_progress(owner_id,subject_id,unit_id,learning_tier,progress_state,review_due_at,
         rule_version,evidence_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(owner_id,subject_id,unit_id) DO UPDATE SET progress_state=excluded.progress_state,
         review_due_at=excluded.review_due_at,rule_version=excluded.rule_version,
         evidence_digest=excluded.evidence_digest,updated_at=now()`,
      [ownerId, SUBJECT, question.rows[0].unit_id, progress.rows[0]?.learning_tier || "C", progressState,
        unitDue.rows[0].review_due_at, rule.rule_version, requestDigest]);
    await client.query(
      `INSERT INTO learning_events(owner_id,subject_id,unit_id,event_type,payload)
       VALUES($1,$2,$3,'CONCEPT_RECALL',$4)`,
      [ownerId, SUBJECT, question.rows[0].unit_id, JSON.stringify({ questionId, memoryResult,
        intervalDays: schedule.intervalDays, attemptId: inserted.rows[0].attempt_id })]);
    return { ok: true, replayed: false, attemptId: inserted.rows[0].attempt_id,
      nextReviewAt: schedule.nextReviewAt, intervalDays: schedule.intervalDays };
  });
}

export function createConceptExecutor(options = {}) {
  const pool = options.pool || createPostgresPool(options.env);
  return async (name, input, context = {}) => {
    const ownerId = required(context.ownerId, "authenticated owner");
    if (name === "getCivilConceptUnit") return getConceptUnit(pool, ownerId, input);
    if (name === "setCivilStudyMode") return setStudyMode(pool, ownerId, input);
    if (name === "getCivilDueReviews") return getDueReviews(pool, ownerId, input);
    if (name === "submitCivilRecall") return submitRecall(pool, ownerId, input);
    throw new Error(`unsupported concept tool: ${name}`);
  };
}
