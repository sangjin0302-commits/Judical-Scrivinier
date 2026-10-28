import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const SHEET_ID = process.env.TEST_SPREADSHEET_ID;
if (!SHEET_ID) throw new Error("TEST_SPREADSHEET_ID is required");
const repo = resolve(import.meta.dirname, "../../..");
const privateDir = resolve(repo, "private");
const clientFile = process.env.GOOGLE_OAUTH_CLIENT_FILE || resolve(privateDir, "oauth/google-desktop-client.json");
const tokenFile = process.env.GOOGLE_OAUTH_TOKEN_FILE || resolve(privateDir, "oauth/google-user-token.json");

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const stableJson = (value) => JSON.stringify(value, Object.keys(value).sort());
const serialDate = (value) => typeof value === "number" && value > 1
  ? (value > 100000000000 ? new Date(value) : new Date(Date.UTC(1899, 11, 30) + value * 86400000)) : null;
const stageOf = (type) => String(type).includes("2차") ? "P2" : "P1";
const rowsWithKey = (rows) => rows.filter((row) => String(row?.[0] || "").trim());
function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(field); field = ""; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] || ""])));
}

const oauthClient = JSON.parse(await readFile(clientFile, "utf8"));
const oauthToken = JSON.parse(await readFile(tokenFile, "utf8"));
const installed = oauthClient.installed || oauthClient.web;
const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: installed.client_id, client_secret: installed.client_secret,
    refresh_token: oauthToken.refresh_token, grant_type: "refresh_token" })
});
const token = await tokenResponse.json();
if (!tokenResponse.ok || !token.access_token) throw new Error("Google OAuth refresh failed");

async function sheetRange(a1) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(a1)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Sheets read failed: ${response.status} ${detail?.error?.status || ""} ${detail?.error?.message || ""}`);
  }
  return (await response.json()).values || [];
}

const executionDeployment = process.env.APPS_SCRIPT_DEPLOYMENT_ID;
async function scriptCall(functionName, payload = {}) {
  const response = await fetch(`https://script.googleapis.com/v1/scripts/${executionDeployment}:run`, {
    method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ function: functionName, parameters: [payload], devMode: false })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Apps Script export failed: ${response.status} ${data.error?.message || ""}`);
  return data.response?.result;
}

const exportManifest = executionDeployment ? await scriptCall("DBF_manifest") : null;
async function readRows(sheet, startRow, columns, endRow) {
  if (!executionDeployment) return sheetRange(`${sheet}!A${startRow}:${String.fromCharCode(64 + columns)}${endRow}`);
  const lastRow = Math.min(Number(exportManifest[sheet]?.lastRow || 0), endRow);
  const result = [];
  const chunkRows = Math.max(1, Math.floor(10000 / columns));
  for (let row = startRow; row <= lastRow; row += chunkRows) {
    result.push(...await scriptCall("DBF_exportChunk", { sheet, startRow: row,
      rowCount: Math.min(chunkRows, lastRow - row + 1) }));
  }
  return result;
}

const encodedEncryptionKey = process.env.GRADING_KEY_BASE64;
if (!encodedEncryptionKey) throw new Error("GRADING_KEY_BASE64 is required; refusing to generate a replacement key");
const encryptionKey = Buffer.from(encodedEncryptionKey, "base64");
if (encryptionKey.length !== 32) throw new Error("grading encryption key must be 32 bytes");
const encryptionKeyId = String(process.env.GRADING_ENCRYPTION_KEY_ID || "").trim();
if (!encryptionKeyId) throw new Error("GRADING_ENCRYPTION_KEY_ID is required");
function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

const [problemRows, keyRows, setRows, historyRows, gradeRows, oxRows, settingsRows] = await Promise.all([
  readRows("문제원장",5,35,20004), readRows("채점키_비공개",5,7,20004),
  readRows("세트관리",5,7,10004), readRows("풀이이력",5,17,50004),
  readRows("서술형채점",5,23,10004), readRows("OX정답키",5,8,20004),
  readRows("설정",1,18,100)
]);

const problems = rowsWithKey(problemRows);
const problemByKey = new Map(problems.map((row) => [String(row[0]), row]));
const keyByProblem = new Map(rowsWithKey(keyRows).map((row) => [String(row[0]), row]));
const sets = new Map();
for (const row of rowsWithKey(setRows)) {
  const setId = String(row[0]);
  if (!sets.has(setId)) sets.set(setId, []);
  sets.get(setId).push(row);
}
const history = rowsWithKey(historyRows);
const historiesBySet = new Map();
for (const row of history) {
  const setId = String(row[1] || "");
  if (!setId) continue;
  if (!historiesBySet.has(setId)) historiesBySet.set(setId, []);
  historiesBySet.get(setId).push(row);
}
const gradesBySetKey = new Map(rowsWithKey(gradeRows).map((row) => [`${row[1]}|${row[2]}`, row]));
const oxBySetKey = new Map(rowsWithKey(oxRows).map((row) => [`${row[0]}|${row[2]}`, row]));
const unitRows = parseCsv(await readFile(resolve(repo, "curriculum/units-index.csv"), "utf8"));
const unitById = new Map(unitRows.map((row) => [row.unit_id, row]));
const proposalRows = parseCsv(await readFile(resolve(repo, "mapping/concept-problem-proposals.csv"), "utf8"));
const unitByProblem = new Map(proposalRows.filter((row) => row.unit_id && row.problem_stable_key)
  .map((row) => [row.problem_stable_key, row.unit_id]));

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const connection = process.env.RAILWAY_TEST_TUNNEL === "1" ? {
  host: "127.0.0.1", port: Number(process.env.RAILWAY_TEST_TUNNEL_PORT || 15432),
  user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE, ssl: false
} : { connectionString };
const db = new pg.Client(connection);
await db.connect();
const counts = { problems: 0, gradingKeys: 0, sets: 0, setItems: 0, submissions: 0,
  answers: 0, p1Grades: 0, p2Grades: 0, learningEvents: 0 };
async function batchInsert(table, columns, rows, chunkSize = 200) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize), values = [];
    const placeholders = chunk.map((row) => `(${row.map((value) => {
      values.push(value); return `$${values.length}`;
    }).join(",")})`).join(",");
    await db.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES ${placeholders}`, values);
  }
}

try {
  if (process.env.APPLY_SCHEMA === "1") {
    const migration = await readFile(resolve(import.meta.dirname, "migrations/0001_learning_ledger.sql"), "utf8");
    await db.query(migration);
  }
  await db.query("BEGIN");
  await db.query("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','민법') ON CONFLICT DO NOTHING");
  const unitData = [];
  for (const unitId of new Set(unitByProblem.values())) {
    const unit = unitById.get(unitId);
    if (!unit) throw new Error(`unknown unit id: ${unitId}`);
    unitData.push(["CIVIL", unitId, unit.learning_goal || unit.core_topics || unitId]);
  }
  await batchInsert("units", ["subject_id","unit_id","title"], unitData);
  await db.query(`INSERT INTO review_rules(subject_id,rule_version,rule_payload,rule_digest,active)
    VALUES('CIVIL','sheet-test-v1',$1,$2,true) ON CONFLICT DO NOTHING`,
    [JSON.stringify({ settings: settingsRows }), sha(JSON.stringify(settingsRows))]);

  const problemData = [], gradingKeyData = [];
  for (let index = 0; index < problems.length; index++) {
    const row = problems[index];
    const stableKey = String(row[0]);
    const type = String(row[3] || "");
    const prompt = String(row[6] || "");
    const points = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*점/g)].at(-1);
    const maxPoints = stageOf(type) === "P2" ? Number(points?.[1] || 1) : null;
    const metadata = { sourceId: row[1] || "", originalId: row[2] || "", type,
      detailType: row[4] || "", title: row[5] || "", sourceName: row[7] || "",
      sourceAnchor: row[8] || "", usageState: row[11] || "", verificationState: row[12] || "",
      changeState: row[13] || "", classification: row[16] || "", priority: row[28] || null,
      internalSortKey: row[29] || null, typeSequence: row[30] || null };
    problemData.push(["CIVIL", stableKey, unitByProblem.get(stableKey) || null, stageOf(type), index + 1,
      String(row[8] || row[7] || "test-sheet"), String(row[9] || "unknown"), prompt, maxPoints,
      row[11] === "활성", JSON.stringify(metadata), String(row[34] || sha(prompt))]);
    counts.problems++;
    const key = keyByProblem.get(stableKey);
    if (key) {
      const payload = { answer: key[1], rationale: key[2], rubric: key[3], source: key[4], status: key[6] };
      const version = String(key[5] || row[9] || "unknown");
      gradingKeyData.push(["CIVIL", stableKey, version, encryptJson(payload), sha(JSON.stringify(payload)),
        encryptionKeyId, "verified", true, new Date()]);
      counts.gradingKeys++;
    }
  }
  await batchInsert("problems", ["subject_id","stable_key","unit_id","stage","source_order","source_ref",
    "source_version","prompt_text","max_points","published","selection_metadata","content_digest"], problemData, 100);
  await batchInsert("private_grading_keys", ["subject_id","stable_key","key_version","encrypted_payload","payload_digest",
    "encryption_key_id","verification_state","active_for_grading","verified_at"], gradingKeyData, 100);

  const setData=[], itemData=[], submissionData=[], answerData=[], p1Data=[], p2Data=[], eventData=[];
  for (const [setId, items] of sets) {
    const valid = items.filter((row) => problemByKey.has(String(row[3])));
    if (!valid.length) continue;
    const stages = new Set(valid.map((row) => stageOf(problemByKey.get(String(row[3]))[3])));
    if (stages.size !== 1) throw new Error(`mixed stage set: ${setId}`);
    const stage = [...stages][0];
    const committed = valid.every((row) => row[5] === "예");
    const created = serialDate(valid[0][1]);
    setData.push([setId,"legacy-test-sheet","CIVIL",stage,`legacy:${setId}`,
      sha(JSON.stringify(valid.map((row) => row.slice(2, 7)))),committed ? "COMMITTED" : "PREPARED",
      created || new Date(),committed ? (created || new Date()) : null]);
    counts.sets++;
    for (const row of valid) {
      itemData.push([setId,"CIVIL",Number(row[2]),String(row[3])]);
      counts.setItems++;
    }

    const answers = historiesBySet.get(setId) || [];
    if (!answers.length) continue;
    const answerDigest = sha(JSON.stringify(answers.map((row) => [row[0], row[3]])));
    const gradeDigest = sha(JSON.stringify(answers.map((row) => [row[0], row[5], row[6]])));
    const complete = committed && answers.length === valid.length;
    const submissionId = crypto.randomUUID();
    const submittedAt = serialDate(answers[0][2]) || new Date();
    submissionData.push([submissionId,setId,"legacy-test-sheet","CIVIL",`legacy-grade:${setId}`,
      answerDigest,gradeDigest,complete ? "COMMITTED" : "PREPARED",submittedAt,complete ? submittedAt : null]);
    counts.submissions++;
    for (const row of answers) {
      const stableKey = String(row[0]);
      if (!problemByKey.has(stableKey)) continue;
      answerData.push([submissionId,"CIVIL",stableKey,String(row[3] || ""),sha(String(row[3] || "")),
        serialDate(row[2]) || new Date()]);
      counts.answers++;
      const problem = problemByKey.get(stableKey);
      if (stageOf(problem[3]) === "P1") {
        const snapshot = oxBySetKey.get(`${setId}|${stableKey}`);
        if (!snapshot) continue;
        const correct = String(row[3] || "").trim().toUpperCase() === String(snapshot[3] || "").trim().toUpperCase();
        p1Data.push([submissionId,"CIVIL",stableKey,correct,String(snapshot[6] || "unknown")]);
        counts.p1Grades++;
      } else {
        const grade = gradesBySetKey.get(`${setId}|${stableKey}`);
        if (!grade) continue;
        const payload = { errorType: grade[17] || "", missingOutline: grade[18] || "",
          wrongLaw: grade[19] || "", applicationFix: grade[20] || "", modelDifference: grade[21] || "",
          nextReview: grade[22] || "" };
        p2Data.push([submissionId,"CIVIL",stableKey,
          Number(grade[5] || 0), Number(grade[4] || row[6] || 1), ...grade.slice(7, 14).map((v) => Number(v || 0)),
          String(grade[17] || row[9] || "없음"), String(row[10] || "해당없음"), String(grade[22] || "사례형 재작성"),
          JSON.stringify(payload), sha(JSON.stringify(payload))]);
        counts.p2Grades++;
      }
      eventData.push(["legacy-test-sheet","CIVIL",stableKey,"SHEET_HISTORY_IMPORTED",
        JSON.stringify({ setId, validState: row[15] || "", score: row[5], maxPoints: row[6] }),
        serialDate(row[2]) || new Date()]);
      counts.learningEvents++;
    }
  }
  await batchInsert("issue_sets", ["set_id","owner_id","subject_id","stage","request_id","request_digest","state","created_at","committed_at"], setData, 100);
  await batchInsert("issue_set_items", ["set_id","subject_id","position","stable_key"], itemData, 200);
  await batchInsert("submissions", ["submission_id","set_id","owner_id","subject_id","request_id","answer_digest","grade_digest","state","created_at","committed_at"], submissionData, 100);
  await batchInsert("original_answers", ["submission_id","subject_id","stable_key","answer_text","answer_digest","created_at"], answerData, 100);
  await batchInsert("p1_grades", ["submission_id","subject_id","stable_key","is_correct","key_version"], p1Data, 200);
  await batchInsert("p2_grades", ["submission_id","subject_id","stable_key","awarded_points","max_points",
    "issue_score","outline_score","law_score","precedent_score","application_score","conclusion_score","expression_score",
    "error_type","check_type","next_review_type","evaluation_payload","evaluation_digest"], p2Data, 100);
  await batchInsert("learning_events", ["owner_id","subject_id","stable_key","event_type","payload","created_at"], eventData, 100);
  await db.query(`INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,
    payload_digest,metadata) VALUES('migration:test-sheet','CIVIL','IMPORT','spreadsheet',$1,$2,$3)`,
    [SHEET_ID, sha(JSON.stringify(counts)), JSON.stringify({ counts })]);
  await db.query("COMMIT");
  process.stdout.write(JSON.stringify({ ok: true, counts }));
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally { await db.end(); }
