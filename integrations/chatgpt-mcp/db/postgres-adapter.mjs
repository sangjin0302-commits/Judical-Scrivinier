import crypto from "node:crypto";
import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SUBJECT = "CIVIL";
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
            p.prompt_text, p.max_points, p.source_version,
            p.selection_metadata
       FROM issue_set_items i JOIN problems p
         ON p.subject_id=i.subject_id AND p.stable_key=i.stable_key
      WHERE i.set_id=$1 ORDER BY i.position`, [setId]);
  return result.rows;
}

async function issue(pool, ownerId, stage, input, configuredKeyId) {
  const count = stage === "P1" ? 10 : (input.caseCount ?? 1);
  const request = { requestId: input.requestId, count, mode: input.mode || "전범위", keyword: input.keyword || "" };
  const requestDigest = digest(request);
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [digest([ownerId, SUBJECT, stage, input.requestId])]);
    const previous = await client.query(
      `SELECT set_id, request_digest FROM issue_sets
       WHERE owner_id=$1 AND subject_id=$2 AND stage=$3 AND request_id=$4 FOR UPDATE`,
      [ownerId, SUBJECT, stage, input.requestId]);
    if (previous.rowCount) {
      if (previous.rows[0].request_digest !== requestDigest) throw new Error("changed issue payload rejected");
      const items = await setItems(client, previous.rows[0].set_id);
      return { ok: true, replayed: true, setId: previous.rows[0].set_id, count: items.length,
        questions: items.map(publicProblem) };
    }
    const keyword = String(input.keyword || "").trim();
    const candidates = await client.query(
      `SELECT p.stable_key, p.prompt_text, p.max_points, p.source_version, p.selection_metadata,
              k.key_version AS grading_key_version, k.encryption_key_id AS grading_encryption_key_id
         FROM problems p JOIN private_grading_keys k
           ON k.subject_id=p.subject_id AND k.stable_key=p.stable_key
        WHERE p.subject_id=$1 AND p.stage=$2 AND p.published=true
          AND k.verification_state='verified' AND k.active_for_grading=true
          AND k.encryption_key_id=$5
          AND ($3='' OR p.prompt_text ILIKE '%' || $3 || '%' OR p.selection_metadata::text ILIKE '%' || $3 || '%')
        ORDER BY md5(p.stable_key || $4) LIMIT $6`, [SUBJECT, stage, keyword, input.requestId, configuredKeyId, count]);
    if (candidates.rowCount !== count) throw new Error(`not enough published ${stage} problems`);
    const setId = `${stage}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO issue_sets(set_id,owner_id,subject_id,stage,request_id,request_digest)
       VALUES($1,$2,$3,$4,$5,$6)`, [setId, ownerId, SUBJECT, stage, input.requestId, requestDigest]);
    for (let index = 0; index < candidates.rows.length; index++) {
      await client.query(
        `INSERT INTO issue_set_items(set_id,subject_id,position,stable_key,key_version,encryption_key_id)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [setId, SUBJECT, index + 1, candidates.rows[index].stable_key,
          candidates.rows[index].grading_key_version, candidates.rows[index].grading_encryption_key_id]);
    }
    await client.query(
      `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,request_id,payload_digest)
       VALUES($1,$2,'ISSUE','issue_set',$3,$4,$5)`, [ownerId, SUBJECT, setId, input.requestId, requestDigest]);
    return { ok: true, replayed: false, setId, count, questions: candidates.rows.map(publicProblem) };
  });
}

function publicProblem(row, index) {
  return { position: row.position ?? index + 1, key: row.stable_key, prompt: row.prompt_text,
    ...(row.max_points == null ? {} : { maxPoints: Number(row.max_points) }) };
}

async function latestKeys(client, items, configuredKeyId) {
  const result = new Map();
  for (const item of items) {
    const snapshotted = Boolean(item.grading_key_version && item.grading_encryption_key_id);
    const keyVersion = item.grading_key_version || item.source_version;
    const encryptionKeyId = item.grading_encryption_key_id || configuredKeyId;
    if (encryptionKeyId !== configuredKeyId) throw new Error("set grading key is not available in this deployment");
    const key = await client.query(
      `SELECT key_version, encryption_key_id, encrypted_payload, payload_digest FROM private_grading_keys
       WHERE subject_id=$1 AND stable_key=$2
         AND verification_state='verified'
         AND encryption_key_id=$3 AND key_version=$4
         AND ($5::boolean=false OR active_for_grading=true)
       LIMIT 1`,
      [SUBJECT, item.stable_key, encryptionKeyId, keyVersion, !snapshotted]);
    if (key.rowCount !== 1) throw new Error(`grading key missing: ${item.stable_key}`);
    result.set(item.stable_key, key.rows[0]);
  }
  return result;
}

async function gradeP1(pool, ownerId, input, key, keyId) {
  const answerDigest = digest(input.answers);
  return inTransaction(pool, async (client) => {
    await ownedSet(client, input.setId, ownerId, "P1");
    const items = await setItems(client, input.setId);
    if (items.length !== 10 || input.answers.length !== items.length) throw new Error("answer count mismatch");
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
    await finalizeSubmission(client, ownerId, input.setId, submissionId, gradeDigest, "P1_GRADED", results);
    return { ok: true, replayed: false, setId: input.setId,
      correct: results.filter((item) => item.correct).length, total: results.length, results };
  });
}

async function prepareP2(pool, ownerId, input, encryptionKey, keyId) {
  const normalized = [...input.answers].sort((a, b) => a.key.localeCompare(b.key));
  const answerDigest = digest(normalized);
  const prepared = await inTransaction(pool, async (client) => {
    await ownedSet(client, input.setId, ownerId, "P2");
    const items = await setItems(client, input.setId);
    if (items.length !== normalized.length || items.some((item) => !normalized.find((a) => a.key === item.stable_key))) {
      throw new Error("answers must exactly match the issued P2 set");
    }
    const prior = await client.query("SELECT * FROM submissions WHERE set_id=$1 FOR UPDATE", [input.setId]);
    if (prior.rowCount) {
      if (prior.rows[0].answer_digest !== answerDigest) throw new Error("changed answer payload rejected");
      return { replayed: true, submissionId: prior.rows[0].submission_id, items };
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
    return { replayed: false, submissionId: submission.rows[0].submission_id, items };
  });
  const client = await pool.connect();
  try {
    const keys = await latestKeys(client, prepared.items, keyId);
    return { ok: true, replayed: prepared.replayed, setId: input.setId,
      rubrics: prepared.items.map((item) => {
        const keyRow = keys.get(item.stable_key);
        const payload = decryptGradingPayload(keyRow.encrypted_payload, encryptionKey,
          gradingAad(SUBJECT, item.stable_key, keyRow.key_version, keyRow.encryption_key_id), keyRow.payload_digest);
        return { key: item.stable_key, maxPoints: Number(item.max_points), rubric: payload.rubric,
          rationale: payload.rationale, source: payload.source };
      }) };
  } finally { client.release(); }
}

async function commitP2(pool, ownerId, input) {
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
      return { ok: true, replayed: true, setId: input.setId, submissionId: row.submission_id };
    }
    if (items.length !== evaluations.length || items.some((item) => !evaluations.find((e) => e.key === item.stable_key))) {
      throw new Error("evaluations must exactly match the issued P2 set");
    }
    for (const evaluation of evaluations) {
      const item = items.find((candidate) => candidate.stable_key === evaluation.key);
      if (Number(evaluation.maxPoints) !== Number(item.max_points)) throw new Error(`maxPoints mismatch: ${evaluation.key}`);
      const payload = { correction: evaluation.correction || "", missingOutline: evaluation.missingOutline || "",
        wrongLaw: evaluation.wrongLaw || "", applicationFix: evaluation.applicationFix || "",
        modelDifference: evaluation.modelDifference || "", nextReview: evaluation.nextReview };
      await client.query(
        `INSERT INTO p2_grades(submission_id,subject_id,stable_key,awarded_points,max_points,
          issue_score,outline_score,law_score,precedent_score,application_score,conclusion_score,expression_score,
          error_type,check_type,next_review_type,evaluation_payload,evaluation_digest,key_version,encryption_key_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [row.submission_id, SUBJECT, evaluation.key, evaluation.awardedPoints, evaluation.maxPoints,
          evaluation.scores.issue, evaluation.scores.outline, evaluation.scores.law, evaluation.scores.precedent,
          evaluation.scores.application, evaluation.scores.conclusion, evaluation.scores.expression,
          evaluation.errorType, evaluation.checkType, evaluation.nextReview, JSON.stringify(payload), digest(payload),
          item.grading_key_version || item.source_version, item.grading_encryption_key_id]);
      await client.query(
        `INSERT INTO learning_events(owner_id,subject_id,stable_key,event_type,payload)
         VALUES($1,$2,$3,'P2_GRADED',$4)`, [ownerId, SUBJECT, evaluation.key,
          JSON.stringify({ awardedPoints: evaluation.awardedPoints, maxPoints: evaluation.maxPoints, scores: evaluation.scores })]);
    }
    await finalizeSubmission(client, ownerId, input.setId, row.submission_id, gradeDigest, "P2_GRADED", evaluations);
    return { ok: true, replayed: false, setId: input.setId, submissionId: row.submission_id };
  });
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
    if (name === "issueCivilP1") return issue(pool, ownerId, "P1", payload, keyId());
    if (name === "issueCivilP2") return issue(pool, ownerId, "P2", payload, keyId());
    if (name === "gradeCivilP1") return gradeP1(pool, ownerId, payload, gradingKey(env), keyId());
    if (name === "prepareCivilP2Grade") return prepareP2(pool, ownerId, payload, gradingKey(env), keyId());
    if (name === "commitCivilP2Grade") return commitP2(pool, ownerId, payload);
    throw new Error(`unsupported PostgreSQL tool: ${name}`);
  };
}
