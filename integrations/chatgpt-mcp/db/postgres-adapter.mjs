import crypto from "node:crypto";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";
import { getExamProgress } from "./exam-progress.mjs";
import { buildP2SemanticAudit, isNonSubstantiveP2Answer } from "./p2-semantic-evaluation.mjs";
import { selectExamCandidates } from "./fast-exam-selection.mjs";
import { normalizeP2Submission } from "./p2-submission-contract.mjs";
import { validateP2FixedCriteria } from "./p2-fixed-criteria.mjs";
import { withDriveSourceHealth } from "./drive-source-health.mjs";

const SUBJECT = "CIVIL";
const P2_SCORE_FIELDS = ["issue", "outline", "law", "precedent", "application", "conclusion", "expression"];
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
const canonical = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

export function gradingKey(env = process.env) {
  const encoded = required(env.GRADING_KEY_BASE64, "GRADING_KEY_BASE64");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("GRADING_KEY_BASE64 must decode to exactly 32 bytes");
  return key;
}

export function gradingAad(subjectId, stableKey, keyVersion, encryptionKeyId) {
  return Buffer.from(JSON.stringify({ subjectId, stableKey, keyVersion, encryptionKeyId }), "utf8");
}

export function decryptGradingPayload(encrypted, key, aad, expectedDigest) {
  const bytes = Buffer.from(encrypted);
  if (bytes.length < 29) throw new Error("encrypted grading payload is invalid");
  if (!Buffer.isBuffer(aad) || !aad.length) throw new Error("grading payload AAD is required");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  if (!expectedDigest || digest(plaintext) !== expectedDigest) throw new Error("grading payload digest mismatch");
  return JSON.parse(plaintext);
}

export function createPostgresPool(env = process.env) {
  const connectionString = required(env.DATABASE_URL || env.DATABASE_PUBLIC_URL, "DATABASE_URL");
  return new pg.Pool(postgresConnectionOptions(connectionString, {
    max: Math.max(1, Math.min(Number(env.PGPOOL_MAX || 2), 4)),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  }));
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ownedSet(client, setId, ownerId, stage) {
  const result = await client.query(
    `SELECT set_id, owner_id, subject_id, stage, state FROM issue_sets
     WHERE set_id=$1 FOR UPDATE`, [setId]);
  if (result.rowCount !== 1) throw new Error("set not found");
  const row = result.rows[0];
  if (row.owner_id !== ownerId) throw new Error("set ownership denied");
  if (row.subject_id !== SUBJECT || row.stage !== stage) throw new Error("set stage mismatch");
  return row;
}

async function setItems(client, setId) {
  const result = await client.query(
    `SELECT i.position, i.stable_key, i.key_version AS grading_key_version,
            i.encryption_key_id AS grading_encryption_key_id,
            COALESCE(v.prompt_text,p.prompt_text) AS prompt_text,
            COALESCE(v.max_points,p.max_points) AS max_points,
            COALESCE(v.source_version,p.source_version) AS source_version,
            COALESCE(v.selection_metadata,p.selection_metadata) AS selection_metadata
       FROM issue_set_items i JOIN problems p
         ON p.subject_id=i.subject_id AND p.stable_key=i.stable_key
       LEFT JOIN problem_versions v ON v.version_id=i.problem_version_id
      WHERE i.set_id=$1 ORDER BY i.position`, [setId]);
  return result.rows;
}

async function issue(pool, ownerId, stage, input, configuredKeyId) {
  const count = stage === "P1" ? (input.count ?? 10) : (input.caseCount ?? 1);
  const request = { requestId: input.requestId, count, mode: input.mode || "전범위",
    keyword: input.keyword || "", specificKeys: input.specificKeys || [],
    questionType: input.questionType || "", year: input.year || "", session: input.session || "",
    questionNumber: input.questionNumber || "", lowScoreBelow: input.lowScoreBelow ?? null };
  const requestDigest = digest(request);
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [digest([ownerId, SUBJECT, stage])]);
    const previous = await client.query(
      `SELECT set_id, request_digest FROM issue_sets
       WHERE owner_id=$1 AND subject_id=$2 AND stage=$3 AND request_id=$4 FOR UPDATE`,
      [ownerId, SUBJECT, stage, input.requestId]);
    if (previous.rowCount) {
      if (previous.rows[0].request_digest !== requestDigest) throw new Error("changed issue payload rejected");
      const items = await setItems(client, previous.rows[0].set_id);
      return { ok: true, replayed: true, setId: previous.rows[0].set_id, count: items.length,
        ...(stage === "P2" ? { caseCount: count } : {}), questions: items.map(publicProblem) };
    }
    const selected = await selectExamCandidates(client, { stage, ownerId, requestId: input.requestId,
      keyId: configuredKeyId, mode: input.mode, keyword: input.keyword, count: input.count,
      caseCount: input.caseCount, specificKeys: input.specificKeys,
      questionType: input.questionType, year: input.year, session: input.session,
      questionNumber: input.questionNumber, lowScoreBelow: input.lowScoreBelow });
    const candidates = { rows: selected, rowCount: selected.length };
    const setId = `${stage}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest)
       VALUES($1,$2,$3,$4,$5,$6)`, [setId, ownerId, SUBJECT, stage, input.requestId, requestDigest]);
    for (let index = 0; index < candidates.rows.length; index++) {
      await client.query(
        `INSERT INTO issue_set_items(set_id,subject_id,position,stable_key,key_version,encryption_key_id,
          problem_version_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [setId, SUBJECT, index + 1, candidates.rows[index].stable_key,
          candidates.rows[index].grading_key_version, candidates.rows[index].grading_encryption_key_id,
          candidates.rows[index].problem_version_id]);
    }
    await client.query(
      `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,request_id,payload_digest)
       VALUES($1,$2,'ISSUE','issue_set',$3,$4,$5)`, [ownerId, SUBJECT, setId, input.requestId, requestDigest]);
    return { ok: true, replayed: false, setId, count: candidates.rowCount,
      ...(stage === "P2" ? { caseCount: count } : {}), questions: candidates.rows.map(publicProblem) };
  });
}

function publicProblem(row, index) {
  return { position: row.position ?? index + 1, key: row.stable_key, prompt: row.prompt_text,
    ...(row.max_points == null ? {} : { maxPoints: Number(row.max_points) }) };
}

async function latestKeys(client, items, configuredKeyId) {
  const wanted = items.map((item) => ({ stableKey: item.stable_key,
    keyVersion: item.grading_key_version || item.source_version,
    encryptionKeyId: item.grading_encryption_key_id || configuredKeyId,
    legacy: !(item.grading_key_version && item.grading_encryption_key_id) }));
  if (wanted.some((item) => item.encryptionKeyId !== configuredKeyId)) {
    throw new Error("set grading key is not available in this deployment");
  }
  const keys = await client.query(
    `WITH wanted AS (
       SELECT * FROM unnest($2::text[],$3::text[],$4::text[],$5::boolean[])
         AS w(stable_key,key_version,encryption_key_id,legacy)
     )
     SELECT k.stable_key,k.key_version,k.encryption_key_id,k.encrypted_payload,k.payload_digest
       FROM private_grading_keys k JOIN wanted w
         ON k.stable_key=w.stable_key AND k.key_version=w.key_version
        AND k.encryption_key_id=w.encryption_key_id
      WHERE k.subject_id=$1 AND k.verification_state='verified'
        AND (NOT w.legacy OR k.active_for_grading=true)`,
    [SUBJECT, wanted.map((item) => item.stableKey), wanted.map((item) => item.keyVersion),
      wanted.map((item) => item.encryptionKeyId), wanted.map((item) => item.legacy)]);
  const result = new Map(keys.rows.map((row) => [row.stable_key, row]));
  if (result.size !== wanted.length || keys.rowCount !== wanted.length) {
    throw new Error("one or more snapshotted grading keys are missing");
  }
  return result;
}

async function gradeP1(pool, ownerId, input, key, keyId) {
  const answerDigest = digest(input.answers);
  return inTransaction(pool, async (client) => {
    await ownedSet(client, input.setId, ownerId, "P1");
    const items = await setItems(client, input.setId);
    if (items.length < 1 || items.length > 40 || input.answers.length !== items.length) {
      throw new Error("answer count mismatch");
    }
    const prior = await client.query("SELECT * FROM submissions WHERE set_id=$1 FOR UPDATE", [input.setId]);
    if (prior.rowCount) {
      if (prior.rows[0].answer_digest !== answerDigest) throw new Error("changed answer payload rejected");
      const grades = await client.query(
        `SELECT g.stable_key, g.is_correct FROM p1_grades g WHERE g.submission_id=$1 ORDER BY g.stable_key`,
        [prior.rows[0].submission_id]);
      return { ok: true, replayed: true, setId: input.setId, correct: grades.rows.filter((r) => r.is_correct).length,
        total: grades.rowCount, results: grades.rows.map((r) => ({ key: r.stable_key, correct: r.is_correct })) };
    }
    const submission = await client.query(
      `INSERT INTO submissions(set_id,owner_id,subject_id,request_id,answer_digest)
       VALUES($1,$2,$3,$4,$5) RETURNING submission_id`,
      [input.setId, ownerId, SUBJECT, `grade:${input.setId}`, answerDigest]);
    const submissionId = submission.rows[0].submission_id;
    for (let index = 0; index < items.length; index++) {
      await client.query(
        `INSERT INTO original_answers(submission_id,subject_id,stable_key,answer_text,answer_digest)
         VALUES($1,$2,$3,$4,$5)`, [submissionId, SUBJECT, items[index].stable_key, input.answers[index], digest(input.answers[index])]);
    }
    const keys = await latestKeys(client, items, keyId);
    const results = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const keyRow = keys.get(item.stable_key);
      const payload = decryptGradingPayload(keyRow.encrypted_payload, key,
        gradingAad(SUBJECT, item.stable_key, keyRow.key_version, keyRow.encryption_key_id), keyRow.payload_digest);
      const expected = String(payload.answer || "").trim().toUpperCase();
      if (!['O', 'X'].includes(expected)) throw new Error(`invalid P1 grading key: ${item.stable_key}`);
      const correct = input.answers[index] === expected;
      await client.query(
        `INSERT INTO p1_grades(submission_id,subject_id,stable_key,is_correct,key_version,encryption_key_id)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [submissionId, SUBJECT, item.stable_key, correct, keyRow.key_version, keyRow.encryption_key_id]);
      await client.query(
        `INSERT INTO learning_events(owner_id,subject_id,stable_key,event_type,payload)
         VALUES($1,$2,$3,'P1_GRADED',$4)`, [ownerId, SUBJECT, item.stable_key, JSON.stringify({ correct })]);
      results.push({ key: item.stable_key, correct, answer: expected, rationale: payload.rationale || "" });
    }
    const gradeDigest = digest(results.map(({ key: stableKey, correct }) => ({ key: stableKey, correct })));
    await scheduleExamReviewDue(client, ownerId, results.map((item) => item.key), submissionId);
    await finalizeSubmission(client, ownerId, input.setId, submissionId, gradeDigest, "P1_GRADED", results);
    return { ok: true, replayed: false, setId: input.setId,
      correct: results.filter((item) => item.correct).length, total: results.length, results };
  });
}

async function prepareP2(pool, ownerId, input, encryptionKey, keyId) {
  const prepared = await inTransaction(pool, async (client) => {
    await ownedSet(client, input.setId, ownerId, "P2");
    const items = await setItems(client, input.setId);
    const normalizedSubmission = normalizeP2Submission(items.map((item) => item.stable_key), input.answers);
    const normalized = normalizedSubmission.submittedAnswers;
    const answerDigest = digest(normalized);
    const prior = await client.query("SELECT * FROM submissions WHERE set_id=$1 FOR UPDATE", [input.setId]);
    if (prior.rowCount) {
      if (prior.rows[0].answer_digest !== answerDigest) throw new Error("changed answer payload rejected");
      return { replayed: true, submissionId: prior.rows[0].submission_id, items,
        subquestions: normalizedSubmission.subquestions };
    }
    const submission = await client.query(
      `INSERT INTO submissions(set_id,owner_id,subject_id,request_id,answer_digest)
       VALUES($1,$2,$3,$4,$5) RETURNING submission_id`,
      [input.setId, ownerId, SUBJECT, `prepare:${input.setId}`, answerDigest]);
    for (const answer of normalized) {
      await client.query(
        `INSERT INTO original_answers(submission_id,subject_id,stable_key,answer_text,answer_digest)
         VALUES($1,$2,$3,$4,$5)`, [submission.rows[0].submission_id, SUBJECT, answer.key, answer.text, digest(answer.text)]);
    }
    await client.query(
      `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,request_id,payload_digest)
       VALUES($1,$2,'P2_PREPARE','submission',$3,$4,$5)`,
      [ownerId, SUBJECT, submission.rows[0].submission_id, `prepare:${input.setId}`, answerDigest]);
    return { replayed: false, submissionId: submission.rows[0].submission_id, items,
      subquestions: normalizedSubmission.subquestions };
  });
  const client = await pool.connect();
  try {
    const keys = await latestKeys(client, prepared.items, keyId);
    return { ok: true, replayed: prepared.replayed, setId: input.setId,
      subquestions: prepared.subquestions,
      rubrics: prepared.items.map((item) => {
        const keyRow = keys.get(item.stable_key);
        const payload = decryptGradingPayload(keyRow.encrypted_payload, encryptionKey,
          gradingAad(SUBJECT, item.stable_key, keyRow.key_version, keyRow.encryption_key_id), keyRow.payload_digest);
        if (Object.hasOwn(payload, "fixedCriteriaManifest")) {
          validateP2FixedCriteria(payload.fixedCriteriaManifest,
            { elements: payload.fixedCriteriaManifest?.requiredElements },
            { modelAnswer: payload.answer, rubric: payload.rubric });
        }
        return { key: item.stable_key, maxPoints: Number(item.max_points), modelAnswer: payload.answer,
          rubric: payload.rubric, rationale: payload.rationale, source: payload.source,
          ...(Object.hasOwn(payload, "fixedCriteriaManifest")
            ? { fixedCriteriaManifest: payload.fixedCriteriaManifest } : {}) };
      }) };
  } finally { client.release(); }
}

async function commitP2(pool, ownerId, input, encryptionKey, keyId) {
  const evaluations = [...input.evaluations].sort((a, b) => a.key.localeCompare(b.key));
  const gradeDigest = digest(evaluations);
  return inTransaction(pool, async (client) => {
    await ownedSet(client, input.setId, ownerId, "P2");
    const items = await setItems(client, input.setId);
    const submission = await client.query("SELECT * FROM submissions WHERE set_id=$1 FOR UPDATE", [input.setId]);
    if (submission.rowCount !== 1) throw new Error("P2 answers must be prepared first");
    const row = submission.rows[0];
    if (row.state === "COMMITTED") {
      if (row.grade_digest !== gradeDigest) throw new Error("changed evaluation payload rejected");
      const grades = await client.query(
        `SELECT stable_key,awarded_points,max_points,evaluation_payload
           FROM p2_grades WHERE submission_id=$1 ORDER BY stable_key`, [row.submission_id]);
      return { ok: true, replayed: true, setId: input.setId, submissionId: row.submission_id,
        summaries: grades.rows.map((grade) => {
          const audit = grade.evaluation_payload?.semanticAudit;
          return { key: grade.stable_key, awardedPoints: Number(grade.awarded_points),
            maxPoints: Number(grade.max_points), ...(audit ? {
              submissionStatus: audit.submissionStatus,
              coreElementMatch: audit.coreElementMatch, matchedLaw: audit.matchedLaw,
              missingLaw: audit.missingLaw, misappliedLaw: audit.misappliedLaw,
              improvement: audit.improvement, scoreRationale: audit.scoreRationale,
              learningScore: audit.learningScore,
            } : {}) };
        }) };
    }
    if (items.length !== evaluations.length || items.some((item) => !evaluations.find((e) => e.key === item.stable_key))) {
      throw new Error("evaluations must exactly match the issued P2 set");
    }
    const keys = await latestKeys(client, items, keyId);
    const originals = await client.query(
      `SELECT stable_key,answer_text FROM original_answers WHERE submission_id=$1`, [row.submission_id]);
    const originalsByKey = new Map(originals.rows.map((answer) => [answer.stable_key, answer.answer_text]));
    const summaries = [];
    for (const evaluation of evaluations) {
      const item = items.find((candidate) => candidate.stable_key === evaluation.key);
      if (Number(evaluation.maxPoints) !== Number(item.max_points)) throw new Error(`maxPoints mismatch: ${evaluation.key}`);
      if (evaluation.awardedPoints != null &&
          (!Number.isFinite(evaluation.awardedPoints) || evaluation.awardedPoints < 0 ||
            evaluation.awardedPoints > Number(item.max_points))) {
        throw new Error("awarded points outside official maximum");
      }
      if (!evaluation.scores || P2_SCORE_FIELDS.some((field) =>
        !Number.isInteger(evaluation.scores[field]) || evaluation.scores[field] < 0 || evaluation.scores[field] > 2)) {
        throw new Error("invalid P2 seven-element scores");
      }
      const submissionStatus = originalsByKey.has(evaluation.key) ? "SUBMITTED" : "UNSUBMITTED";
      if ((submissionStatus === "UNSUBMITTED" ||
          isNonSubstantiveP2Answer(originalsByKey.get(evaluation.key))) &&
          P2_SCORE_FIELDS.some((field) => evaluation.scores[field] !== 0)) {
        throw new Error("unsubmitted or non-substantive answer cannot earn seven-element credit");
      }
      const keyRow = keys.get(item.stable_key);
      const gradingSource = decryptGradingPayload(keyRow.encrypted_payload, encryptionKey,
        gradingAad(SUBJECT, item.stable_key, keyRow.key_version, keyRow.encryption_key_id), keyRow.payload_digest);
      // Trust only the manifest inside the exact encrypted grading-key snapshot.
      // Legacy keys remain compatible; the global P2 acceptance gate is unchanged.
      const fixedCriteria = Object.hasOwn(gradingSource, "fixedCriteriaManifest")
        ? validateP2FixedCriteria(gradingSource.fixedCriteriaManifest, evaluation.semanticAnalysis,
          { modelAnswer: gradingSource.answer, rubric: gradingSource.rubric }) : null;
      const semanticAudit = buildP2SemanticAudit(evaluation.semanticAnalysis, {
        modelAnswer: gradingSource.answer, rubric: gradingSource.rubric,
        originalAnswer: originalsByKey.get(item.stable_key), maxPoints: Number(item.max_points),
        awardedPoints: evaluation.awardedPoints, submissionStatus });
      if (fixedCriteria) semanticAudit.fixedCriteria = fixedCriteria;
      const awardedPoints = semanticAudit.learningScore.displayedPoints;
      const payload = { correction: evaluation.correction || "", missingOutline: evaluation.missingOutline || "",
        wrongLaw: evaluation.wrongLaw || "", applicationFix: evaluation.applicationFix || "",
        modelDifference: evaluation.modelDifference || "", nextReview: evaluation.nextReview,
        semanticAudit, aiScore: { awardedPoints, officialMaximum: Number(item.max_points),
          label: semanticAudit.learningScore.label, rawPoints: semanticAudit.learningScore.rawPoints,
          rawFraction: semanticAudit.learningScore.rawFraction,
          rationale: semanticAudit.learningScore.calculationRationale },
        sevenElementDiagnostics: evaluation.scores };
      await client.query(
        `INSERT INTO p2_grades(submission_id,subject_id,stable_key,awarded_points,max_points,
          issue_score,outline_score,law_score,precedent_score,application_score,conclusion_score,expression_score,
          error_type,check_type,next_review_type,evaluation_payload,evaluation_digest,key_version,encryption_key_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [row.submission_id, SUBJECT, evaluation.key, awardedPoints, evaluation.maxPoints,
          evaluation.scores.issue, evaluation.scores.outline, evaluation.scores.law, evaluation.scores.precedent,
          evaluation.scores.application, evaluation.scores.conclusion, evaluation.scores.expression,
          evaluation.errorType, evaluation.checkType, evaluation.nextReview, JSON.stringify(payload), digest(payload),
          item.grading_key_version || item.source_version, item.grading_encryption_key_id]);
      await client.query(
        `INSERT INTO learning_events(owner_id,subject_id,stable_key,event_type,payload)
         VALUES($1,$2,$3,'P2_GRADED',$4)`, [ownerId, SUBJECT, evaluation.key,
          JSON.stringify({ awardedPoints, maxPoints: evaluation.maxPoints,
            learningScore: semanticAudit.learningScore, sevenElementDiagnostics: evaluation.scores })]);
      summaries.push({ key: evaluation.key, coreElementMatch: semanticAudit.coreElementMatch,
        submissionStatus, awardedPoints, maxPoints: evaluation.maxPoints,
        learningScore: semanticAudit.learningScore,
        matchedLaw: semanticAudit.matchedLaw, missingLaw: semanticAudit.missingLaw,
        misappliedLaw: semanticAudit.misappliedLaw, improvement: semanticAudit.improvement,
        scoreRationale: semanticAudit.scoreRationale });
    }
    await scheduleExamReviewDue(client, ownerId,
      summaries.filter((item) => item.submissionStatus === "SUBMITTED").map((item) => item.key),
      row.submission_id);
    await finalizeSubmission(client, ownerId, input.setId, row.submission_id, gradeDigest, "P2_GRADED",
      evaluations.map(({ semanticAnalysis, ...evaluation }) => evaluation));
    return { ok: true, replayed: false, setId: input.setId, submissionId: row.submission_id, summaries };
  });
}

export async function scheduleExamReviewDue(client, ownerId, stableKeys, submissionId) {
  if (stableKeys.length === 0) return;
  await client.query(
    `INSERT INTO exam_review_due(owner_id,subject_id,stable_key,due_at,review_step,last_submission_id)
     SELECT $1,$2,key,now() + interval '7 days',0,$4::uuid
       FROM unnest($3::text[]) AS key
     ON CONFLICT(owner_id,subject_id,stable_key) DO UPDATE SET
       review_step=least(exam_review_due.review_step + 1,2),
       due_at=now() + CASE least(exam_review_due.review_step + 1,2)
         WHEN 1 THEN interval '21 days' ELSE interval '60 days' END,
       last_submission_id=EXCLUDED.last_submission_id,updated_at=now()
     WHERE exam_review_due.last_submission_id IS DISTINCT FROM EXCLUDED.last_submission_id`,
    [ownerId, SUBJECT, stableKeys, submissionId]);
}

async function finalizeSubmission(client, ownerId, setId, submissionId, gradeDigest, eventType, payload) {
  await client.query("UPDATE submissions SET grade_digest=$1,state='COMMITTED',committed_at=now() WHERE submission_id=$2",
    [gradeDigest, submissionId]);
  await client.query("UPDATE issue_sets SET state='COMMITTED',committed_at=now() WHERE set_id=$1", [setId]);
  await client.query(
    `INSERT INTO sheet_outbox(aggregate_type,aggregate_id,event_type,payload,payload_digest)
     VALUES('submission',$1,$2,$3,$4)`, [submissionId, eventType, JSON.stringify({ setId, payload }), gradeDigest]);
  await client.query(
    `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,payload_digest)
     VALUES($1,$2,$3,'submission',$4,$5)`, [ownerId, SUBJECT, eventType, submissionId, gradeDigest]);
}

export function createPostgresExecutor(options = {}) {
  const pool = options.pool || createPostgresPool(options.env);
  const env = options.env || process.env;
  return async (name, payload, context = {}) => {
    const ownerId = required(context.ownerId, "authenticated owner");
    const keyId = () => required(env.GRADING_ENCRYPTION_KEY_ID, "GRADING_ENCRYPTION_KEY_ID");
    if (name === "getCivilExamProgress") {
      const progress = await getExamProgress(pool, { ...payload, ownerId, subjectId: SUBJECT });
      return withDriveSourceHealth(progress, { pool, ownerId, env });
    }
    if (name === "issueCivilP1") return issue(pool, ownerId, "P1", payload, keyId());
    if (name === "issueCivilP2") return issue(pool, ownerId, "P2", payload, keyId());
    if (name === "gradeCivilP1") return gradeP1(pool, ownerId, payload, gradingKey(env), keyId());
    if (name === "prepareCivilP2Grade") return prepareP2(pool, ownerId, payload, gradingKey(env), keyId());
    if (name === "commitCivilP2Grade") {
      if (env.P2_GRADE_COMMIT_ENABLED !== "true") {
        throw new Error("P2 grade commit awaits official accuracy acceptance");
      }
      // Optional acceptance-run restriction. An explicitly empty list denies all;
      // omitting it preserves existing isolated-test compatibility.
      if (env.P2_GRADE_COMMIT_ALLOWED_SET_IDS != null) {
        const allowedSets = new Set(String(env.P2_GRADE_COMMIT_ALLOWED_SET_IDS)
          .split(",").map(value => value.trim()).filter(Boolean));
        if (!allowedSets.has(payload?.setId)) {
          throw new Error("P2 grade commit set is not allowed for acceptance");
        }
      }
      return commitP2(pool, ownerId, payload, gradingKey(env), keyId());
    }
    throw new Error(`unsupported PostgreSQL tool: ${name}`);
  };
}
