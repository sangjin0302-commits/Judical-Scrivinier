import crypto from "node:crypto";

import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SUBJECT = "CIVIL";
const SHEET_ID = "1PE_82x6LvkV5lousCroj6ZK3ZYfPDCWCx5tNHck3Umc";
const SHEET_TAB = "개념_질문큐";
const SOURCE_ID = `google-sheet:${SHEET_ID}#${SHEET_TAB}`;
const HEADERS = ["질문ID", "단원ID", "권", "원문 페이지", "회상 단계", "질문 (정답 없음)",
  "연계 문제 안정키", "생성 근거", "질문 검증·운영 규칙"];
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

export function parseConceptQuestionRows(values) {
  if (!Array.isArray(values) || JSON.stringify(values[0]) !== JSON.stringify(HEADERS)) {
    throw new Error("concept question source header mismatch");
  }
  const questions = [];
  const questionIds = new Set();
  const units = new Map();
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || row.every((value) => String(value || "").trim() === "")) continue;
    const questionId = required(row[0], "questionId");
    const unitId = required(row[1], "unitId");
    const promptText = required(row[5], "promptText");
    const suffix = questionId.match(/-Q([123])$/);
    if (!suffix || questionId !== `${unitId}-Q${suffix[1]}`) throw new Error("question ID and unit mismatch");
    if (questionIds.has(questionId)) throw new Error("duplicate question ID");
    questionIds.add(questionId);
    const questionOrder = Number(suffix[1]);
    const orders = units.get(unitId) || new Set();
    if (orders.has(questionOrder)) throw new Error("duplicate question order");
    orders.add(questionOrder);
    units.set(unitId, orders);
    questions.push({ questionId, unitId, questionOrder, promptText,
      contentDigest: digest(promptText) });
  }
  if (questions.length !== 720 || units.size !== 240 ||
      [...units.values()].some((orders) => orders.size !== 3)) {
    throw new Error("concept question source must contain 240 units and 720 questions");
  }
  const sourceDigest = digest(JSON.stringify(questions));
  return { questions, sourceDigest };
}

async function googleAccessToken(env, fetchImpl) {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
      client_secret: required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
      refresh_token: required(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error("Google OAuth refresh failed");
  return result.access_token;
}

export async function fetchConceptQuestionRows(env = process.env, fetchImpl = fetch) {
  const token = await googleAccessToken(env, fetchImpl);
  const range = encodeURIComponent(`'${SHEET_TAB}'!A4:I724`);
  const response = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`concept Sheet read failed: ${response.status}`);
  const payload = await response.json();
  return parseConceptQuestionRows(payload.values);
}

export async function importConceptQuestionRows(client, parsed) {
  const { questions, sourceDigest } = parsed;
  if (!Array.isArray(questions) || questions.length !== 720 || !/^[0-9a-f]{64}$/.test(sourceDigest)) {
    throw new Error("validated concept question source required");
  }
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["civil-concept-sheet-questions"]);
    const existing = await client.query(
      `SELECT question_id,unit_id,question_order,content_state,content_digest,prompt_text
         FROM recall_questions WHERE subject_id=$1 FOR UPDATE`, [SUBJECT]);
    if (existing.rowCount !== 720) throw new Error("DB recall question count mismatch");
    const byId = new Map(existing.rows.map((row) => [row.question_id, row]));
    let pending = 0;
    let preserved = 0;
    let replayed = 0;
    for (const item of questions) {
      const row = byId.get(item.questionId);
      if (!row || row.unit_id !== item.unitId || Number(row.question_order) !== item.questionOrder) {
        throw new Error("DB recall question identity mismatch");
      }
      if (row.content_state === "indexed-unavailable" && row.prompt_text === null) pending++;
      else if (row.content_state === "template-unverified" && row.content_digest === item.contentDigest &&
          row.prompt_text === item.promptText) replayed++;
      else if (["source-mapped", "verified"].includes(row.content_state) && row.prompt_text) preserved++;
      else throw new Error("existing recall content conflicts with source");
    }
    if (pending + replayed + preserved !== 720) throw new Error("recall source coverage mismatch");
    if (pending > 0) {
      const update = await client.query(
        `UPDATE recall_questions q SET prompt_text=s.prompt_text,
             content_state='template-unverified',content_digest=s.content_digest,
             source_path=$2,source_version=$3
           FROM jsonb_to_recordset($1::jsonb) AS s(question_id text,prompt_text text,content_digest text)
          WHERE q.subject_id='CIVIL' AND q.question_id=s.question_id
            AND q.content_state='indexed-unavailable' AND q.prompt_text IS NULL`,
        [JSON.stringify(questions.map((item) => ({ question_id: item.questionId,
          prompt_text: item.promptText, content_digest: item.contentDigest }))),
          SOURCE_ID, `sha256:${sourceDigest}`]);
      if (update.rowCount !== pending) throw new Error("recall import update count mismatch");
    }
    await client.query(
      `INSERT INTO concept_question_imports(subject_id,source_id,source_digest,question_count,
         imported_count,preserved_mapped_count)
       VALUES($1,$2,$3,720,$4,$5) ON CONFLICT(subject_id,source_id,source_digest) DO NOTHING`,
      [SUBJECT, SOURCE_ID, sourceDigest, pending, preserved]);
    await client.query("COMMIT");
    return { ok: true, replayed: pending === 0, questions: 720, units: 240,
      imported: pending, preservedSourceMapped: preserved, priorTemplates: replayed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function importConceptSheetQuestions(env = process.env, options = {}) {
  const parsed = await fetchConceptQuestionRows(env, options.fetchImpl || fetch);
  const connectionString = required(env.DATABASE_PUBLIC_URL || env.DATABASE_URL, "DATABASE_URL");
  const pool = options.pool || new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try { return await importConceptQuestionRows(client, parsed); }
  finally { client.release(); if (!options.pool) await pool.end(); }
}
