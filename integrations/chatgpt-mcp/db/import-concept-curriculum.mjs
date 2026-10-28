import crypto from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { postgresConnectionOptions } from "./pg-connection.mjs";

const SUBJECT = "CIVIL";
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const [headers, ...records] = rows.filter((item) => item.some((value) => value !== ""));
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function parseNumberedQuestions(markdown) {
  return String(markdown).split(/\r?\n/).map((line) => line.match(/^\s*\d+\.\s+(.+?)\s*$/)?.[1] || null).filter(Boolean);
}

export function splitLessonLayers(markdown) {
  const source = String(markdown);
  const first = source.match(/## 1층:[^\n]*\n([\s\S]*?)(?=\n## 2층:|$)/)?.[1]?.trim() || "";
  const second = source.match(/## 2층:[^\n]*\n([\s\S]*?)(?=\n## (?!2층:)|$)/)?.[1]?.trim() || "";
  const common = source.match(/\n## 공통[^\n]*\n([\s\S]*)$/)?.[1]?.trim() || "";
  return { first, second, common };
}

async function optionalText(path) {
  try { await access(path); return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function buildCurriculumSnapshot(repositoryRoot) {
  const units = parseCsv(await readFile(resolve(repositoryRoot, "curriculum/units-index.csv"), "utf8"));
  const issues = parseCsv(await readFile(resolve(repositoryRoot, "curriculum/issue-map.csv"), "utf8"));
  const proposals = parseCsv(await readFile(resolve(repositoryRoot, "mapping/concept-problem-proposals.csv"), "utf8"));
  if (units.length !== 240) throw new Error(`expected 240 units, found ${units.length}`);
  const ids = new Set();
  const questionIds = new Set();
  const expanded = [];
  for (const unit of units) {
    if (!unit.unit_id || ids.has(unit.unit_id)) throw new Error(`duplicate or blank unit_id: ${unit.unit_id}`);
    ids.add(unit.unit_id);
    const listedIds = unit.recall_question_ids.split(";").map((value) => value.trim()).filter(Boolean);
    if (listedIds.length !== 3) throw new Error(`${unit.unit_id} must have exactly three recall question ids`);
    for (const questionId of listedIds) {
      if (questionIds.has(questionId)) throw new Error(`duplicate recall question id: ${questionId}`);
      questionIds.add(questionId);
    }
    const lessonPath = unit.lesson_path ? resolve(repositoryRoot, unit.lesson_path) : null;
    const recallPath = unit.recall_path ? resolve(repositoryRoot, unit.recall_path) : null;
    const lessonText = lessonPath ? await optionalText(lessonPath) : null;
    const recallText = recallPath ? await optionalText(recallPath) : null;
    const parsedQuestions = recallText ? parseNumberedQuestions(recallText) : [];
    expanded.push({ ...unit, listedIds, lessonText, recallText, parsedQuestions,
      lessonLayers: lessonText ? splitLessonLayers(lessonText) : null });
  }
  if (questionIds.size !== 720) throw new Error(`expected 720 recall question ids, found ${questionIds.size}`);
  return { units: expanded, issues, proposals };
}

async function storeMaterial(client, unitId, type, sourcePath, content) {
  if (!content) return;
  const contentDigest = digest(content);
  const version = `sha256:${contentDigest.slice(0, 16)}`;
  const prior = await client.query(
    `SELECT material_id, source_version FROM concept_material_versions
      WHERE subject_id=$1 AND unit_id=$2 AND material_type=$3 AND active=true FOR UPDATE`,
    [SUBJECT, unitId, type]);
  if (prior.rows[0]?.source_version === version) return;
  if (prior.rowCount) await client.query("UPDATE concept_material_versions SET active=false WHERE material_id=$1", [prior.rows[0].material_id]);
  await client.query(
    `INSERT INTO concept_material_versions(subject_id,unit_id,material_type,source_path,source_version,
       content_text,content_digest,verification_state,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,'source-present',true)
     ON CONFLICT(subject_id,unit_id,material_type,source_version) DO UPDATE SET active=true`,
    [SUBJECT, unitId, type, sourcePath, version, content, contentDigest]);
}

export async function importCurriculum(client, snapshot) {
  await client.query("BEGIN");
  try {
    const subject = await client.query("SELECT 1 FROM subjects WHERE subject_id=$1", [SUBJECT]);
    if (subject.rowCount !== 1) throw new Error("CIVIL subject must exist before concept import");
    for (const unit of snapshot.units) {
      const metadata = {
        volume: unit.volume, part: unit.part, chapter: unit.chapter, section: unit.section, segment: unit.segment,
        topicStatus: unit.topic_status, sourceStatus: unit.source_status, lessonStatus: unit.lesson_status,
        checkedDate: unit.checked_date,
      };
      await client.query(
        `INSERT INTO units(subject_id,unit_id,title,learning_order,learning_goal,curriculum_metadata,content_state)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(subject_id,unit_id) DO UPDATE SET title=excluded.title,learning_order=excluded.learning_order,
           learning_goal=excluded.learning_goal,curriculum_metadata=excluded.curriculum_metadata,
           content_state=CASE WHEN units.content_state IN ('available','verified') AND excluded.content_state='indexed'
             THEN units.content_state ELSE excluded.content_state END`,
        [SUBJECT, unit.unit_id, [unit.chapter, unit.section, unit.segment].filter(Boolean).join(" · "),
          Number(unit.learning_order), unit.learning_goal, JSON.stringify(metadata), unit.lessonText ? "available" : "indexed"]);
      if (unit.lessonText) {
        await storeMaterial(client, unit.unit_id, "LESSON_LAYER_1", unit.lesson_path, unit.lessonLayers.first);
        await storeMaterial(client, unit.unit_id, "LESSON_LAYER_2", unit.lesson_path, unit.lessonLayers.second);
        await storeMaterial(client, unit.unit_id, "LESSON_COMMON", unit.lesson_path, unit.lessonLayers.common);
      }
      if (unit.recallText) await storeMaterial(client, unit.unit_id, "RECALL_SOURCE", unit.recall_path, unit.recallText);
      for (let index = 0; index < unit.listedIds.length; index += 1) {
        const prompt = unit.parsedQuestions[index] || null;
        const state = prompt ? "source-mapped" : "indexed-unavailable";
        await client.query(
          `INSERT INTO recall_questions(subject_id,unit_id,question_id,question_order,prompt_text,source_path,
             source_version,content_state,content_digest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(subject_id,question_id) DO UPDATE SET unit_id=excluded.unit_id,question_order=excluded.question_order,
             prompt_text=COALESCE(excluded.prompt_text,recall_questions.prompt_text),
             source_path=COALESCE(excluded.source_path,recall_questions.source_path),
             source_version=COALESCE(excluded.source_version,recall_questions.source_version),
             content_state=CASE WHEN excluded.prompt_text IS NULL THEN recall_questions.content_state ELSE excluded.content_state END,
             content_digest=CASE WHEN excluded.prompt_text IS NULL THEN recall_questions.content_digest ELSE excluded.content_digest END`,
          [SUBJECT, unit.unit_id, unit.listedIds[index], index + 1, prompt, unit.recall_path || null,
            unit.recallText ? `sha256:${digest(unit.recallText).slice(0, 16)}` : null, state, digest(prompt || unit.listedIds[index])]);
      }
    }
    for (const issue of snapshot.issues.filter((item) => item.unit_id && item.issue_id && item.learning_tier)) {
      const source = { prerequisites: issue.prerequisites, dangiSource: issue.dangi_source, loanSource: issue.loan_source,
        verificationStatus: issue.verification_status, evidenceRefs: issue.evidence_refs };
      await client.query(
        `INSERT INTO concept_issues(subject_id,unit_id,issue_id,issue_name,issue_tier,classification_basis,
           p1_requirement,p2_requirement,source_metadata,content_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(subject_id,issue_id) DO UPDATE SET unit_id=excluded.unit_id,issue_name=excluded.issue_name,
           issue_tier=excluded.issue_tier,classification_basis=excluded.classification_basis,
           p1_requirement=excluded.p1_requirement,p2_requirement=excluded.p2_requirement,
           source_metadata=excluded.source_metadata,content_digest=excluded.content_digest`,
        [SUBJECT, issue.unit_id, issue.issue_id, issue.issue_name, issue.learning_tier, issue.classification_basis,
          issue.p1_requirement || null, issue.p2_requirement || null, JSON.stringify(source), digest(JSON.stringify(issue))]);
    }
    const rule = { version: "concept-recall-v1", rememberedDays: [1, 7, 21, 60], partialDays: 3, relearnDays: 1 };
    await client.query(
      `INSERT INTO review_rules(subject_id,rule_version,rule_payload,rule_digest,active)
       VALUES($1,$2,$3,$4,false) ON CONFLICT(subject_id,rule_version) DO NOTHING`,
      [SUBJECT, rule.version, JSON.stringify(rule), digest(JSON.stringify(rule))]);
    await client.query("UPDATE review_rules SET active=false WHERE subject_id=$1 AND active=true AND rule_version<>$2",
      [SUBJECT, rule.version]);
    await client.query("UPDATE review_rules SET active=true WHERE subject_id=$1 AND rule_version=$2 AND active=false",
      [SUBJECT, rule.version]);
    for (const proposal of snapshot.proposals.filter((item) => item.unit_id && item.problem_stable_key)) {
      await client.query(
        `INSERT INTO concept_problem_links(subject_id,unit_id,stable_key,link_status,source_ref,source_digest)
         SELECT $1,$2,$3,'candidate',$4,$5
          WHERE EXISTS(SELECT 1 FROM units WHERE subject_id=$1 AND unit_id=$2)
            AND EXISTS(SELECT 1 FROM problems WHERE subject_id=$1 AND stable_key=$3)
         ON CONFLICT(subject_id,unit_id,stable_key) DO NOTHING`,
        [SUBJECT, proposal.unit_id, proposal.problem_stable_key, "mapping/concept-problem-proposals.csv", digest(JSON.stringify(proposal))]);
    }
    await client.query("COMMIT");
    return {
      units: snapshot.units.length,
      recallQuestions: snapshot.units.reduce((total, unit) => total + unit.listedIds.length, 0),
      availableLessons: snapshot.units.filter((unit) => unit.lessonText).length,
      mappedRecallQuestions: snapshot.units.reduce((total, unit) => total + Math.min(unit.parsedQuestions.length, 3), 0),
      issues: snapshot.issues.filter((item) => item.unit_id && item.issue_id && item.learning_tier).length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  // CLI runs outside Railway private DNS; prefer the encrypted public proxy when present.
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const snapshot = await buildCurriculumSnapshot(root);
  const pool = new pg.Pool(postgresConnectionOptions(connectionString, { max: 1 }));
  const client = await pool.connect();
  try { process.stdout.write(JSON.stringify(await importCurriculum(client, snapshot))); }
  finally { client.release(); await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
