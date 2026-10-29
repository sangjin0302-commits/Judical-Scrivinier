import crypto from "node:crypto";

const SUBJECT = "CIVIL";

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const canonical = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) => crypto.createHash("sha256")
  .update(typeof value === "string" ? value : canonical(value)).digest("hex");

function required(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function sha256Digest(value, name) {
  const result = required(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${name} must be a SHA-256 digest`);
  return result;
}

function normalizeProblem(problem) {
  const stage = required(problem.stage, "stage");
  if (!new Set(["P1", "P2"]).has(stage)) throw new Error("stage must be P1 or P2");
  const maxPoints = problem.maxPoints == null ? null : Number(problem.maxPoints);
  if ((stage === "P1" && maxPoints !== null) || (stage === "P2" && !(maxPoints > 0))) {
    throw new Error("maxPoints does not match stage");
  }
  const promptText = required(problem.promptText, "promptText");
  const answerDigest = problem.answerDigest ? sha256Digest(problem.answerDigest, "answerDigest") : null;
  const explanationDigest = problem.explanationDigest ? sha256Digest(problem.explanationDigest, "explanationDigest") : null;
  const gradingKeyVersion = problem.gradingKeyVersion ? required(problem.gradingKeyVersion, "gradingKeyVersion") : null;
  if ((answerDigest === null) !== (gradingKeyVersion === null) || (explanationDigest && !gradingKeyVersion)) {
    throw new Error("grading digests and gradingKeyVersion must be supplied together");
  }
  return {
    stableKey: required(problem.stableKey, "stableKey"),
    sourceLocator: required(problem.sourceLocator, "sourceLocator"),
    sourceVersion: required(problem.sourceVersion, "sourceVersion"),
    sourceOrder: Number(problem.sourceOrder),
    stage,
    unitId: problem.unitId ? String(problem.unitId) : null,
    promptText,
    maxPoints,
    promptDigest: sha256(promptText),
    answerDigest,
    explanationDigest,
    gradingKeyVersion,
    selectionMetadata: problem.selectionMetadata || {},
    // Question-only Google Docs cannot attest grading or curriculum metadata.
    gradingFieldsKnown: problem.gradingFieldsKnown !== false,
    metadataFieldsKnown: problem.metadataFieldsKnown !== false,
  };
}

export function normalizeDocumentSnapshot(input) {
  const problems = (input.problems || []).map(normalizeProblem);
  const sourceId = input.sourceId ? required(input.sourceId, "sourceId") : null;
  if (sourceId && (/[|%_]/.test(sourceId) ||
      problems.some((problem) => !problem.stableKey.startsWith(sourceId + "|")))) {
    throw new Error("sourceId and stable keys do not match");
  }
  if (problems.some((problem) => !Number.isSafeInteger(problem.sourceOrder) || problem.sourceOrder < 0)) {
    throw new Error("sourceOrder must be a non-negative safe integer");
  }
  return {
    documentId: required(input.documentId, "documentId"),
    sourceId,
    title: required(input.title, "title"),
    revisionId: required(input.revisionId, "revisionId"),
    parserVersion: required(input.parserVersion, "parserVersion"),
    modifiedTime: input.modifiedTime || null,
    contentDigest: sha256Digest(input.contentDigest, "contentDigest"),
    problems,
  };
}

function candidate(kind, stableKey, payload, current = null) {
  const noBodyComparison = kind === "DUPLICATE" || kind === "DELETE_CANDIDATE";
  const promptChanged = !noBodyComparison && (kind === "NEW" || Boolean(current && payload.promptDigest !== current.promptDigest));
  const answerChanged = kind === "NEW" ? Boolean(payload.answerDigest)
    : !noBodyComparison && Boolean(current && payload.answerDigest !== current.answerDigest);
  const explanationChanged = kind === "NEW" ? Boolean(payload.explanationDigest)
    : !noBodyComparison && Boolean(current && payload.explanationDigest !== current.explanationDigest);
  const value = { kind, stableKey, promptChanged, answerChanged, explanationChanged, payload };
  return { ...value, candidateDigest: sha256(value) };
}

export function classifyDocumentSnapshot(incomingProblems, currentProblems = [], documentId = null) {
  const incoming = incomingProblems.map(normalizeProblem);
  const currentByKey = new Map(currentProblems.map((problem) => [problem.stableKey, problem]));
  const grouped = new Map();
  for (const problem of incoming) {
    const values = grouped.get(problem.stableKey) || [];
    values.push(problem);
    grouped.set(problem.stableKey, values);
  }
  const results = [];
  for (const [stableKey, values] of grouped) {
    if (values.length > 1) {
      results.push(candidate("DUPLICATE", null, {
        duplicateStableKey: stableKey,
        sourceLocators: values.map((item) => item.sourceLocator),
      }));
      continue;
    }
    let next = values[0];
    const priorRaw = currentByKey.get(stableKey);
    const prior = priorRaw && { ...priorRaw,
      sourceOrder: Number(priorRaw.sourceOrder),
      maxPoints: priorRaw.maxPoints == null ? null : Number(priorRaw.maxPoints) };
    if (!prior) {
      results.push(candidate("NEW", stableKey, next));
      continue;
    }
    currentByKey.delete(stableKey);
    if (!next.gradingFieldsKnown) {
      next = { ...next, answerDigest: prior.answerDigest ?? null,
        explanationDigest: prior.explanationDigest ?? null,
        gradingKeyVersion: prior.gradingKeyVersion ?? null };
    }
    if (!next.metadataFieldsKnown) {
      next = { ...next, unitId: prior.unitId ?? null,
        selectionMetadata: prior.selectionMetadata || {} };
    }
    if (documentId && prior.mappedDocumentId && prior.mappedDocumentId !== documentId) {
      results.push(candidate("DUPLICATE", null, {
        duplicateStableKey: stableKey,
        sourceLocators: [prior.sourceLocator, next.sourceLocator],
        conflictDocumentId: prior.mappedDocumentId,
      }));
      continue;
    }
    const comparable = ["promptDigest", "answerDigest", "explanationDigest", "sourceVersion", "stage",
      "unitId", "sourceOrder", "maxPoints", "sourceLocator"];
    const changed = comparable.some((key) => canonical(next[key]) !== canonical(prior[key]));
    results.push(candidate(changed ? "MODIFIED" : "UNCHANGED", stableKey,
      { ...next, baseVersionId: prior.currentVersionId }, prior));
  }
  for (const prior of currentByKey.values()) {
    results.push(candidate("DELETE_CANDIDATE", prior.stableKey, {
      stableKey: prior.stableKey,
      sourceLocator: prior.sourceLocator,
      currentVersionId: prior.currentVersionId,
    }, prior));
  }
  return results.sort((a, b) => (a.stableKey || a.payload.duplicateStableKey)
    .localeCompare(b.stableKey || b.payload.duplicateStableKey));
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

async function loadCandidates(client, syncRunId) {
  const result = await client.query(
    `SELECT candidate_id, stable_key, candidate_kind, state, prompt_changed,
            answer_changed, explanation_changed
       FROM sync_candidates WHERE sync_run_id=$1 ORDER BY created_at, candidate_id`, [syncRunId]);
  return result.rows;
}

export async function detectGoogleDocsChanges(pool, input, actorId) {
  const snapshot = normalizeDocumentSnapshot(input);
  const requestId = required(input.requestId, "requestId");
  const actor = required(actorId, "actorId");
  const requestDigest = sha256(snapshot);
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`google-docs:${snapshot.documentId}`]);
    const priorRun = await client.query(
      `SELECT sync_run_id, request_digest FROM sync_runs
        WHERE document_id=$1 AND request_id=$2 FOR UPDATE`, [snapshot.documentId, requestId]);
    if (priorRun.rowCount) {
      if (priorRun.rows[0].request_digest !== requestDigest) throw new Error("changed sync request rejected");
      return { ok: true, replayed: true, syncRunId: priorRun.rows[0].sync_run_id,
        candidates: await loadCandidates(client, priorRun.rows[0].sync_run_id) };
    }
    await client.query(
      `INSERT INTO source_documents(document_id,subject_id,title,read_only)
       VALUES($1,$2,$3,true)
       ON CONFLICT(document_id) DO UPDATE SET title=EXCLUDED.title`,
      [snapshot.documentId, SUBJECT, snapshot.title]);
    await client.query(
      `INSERT INTO document_revisions(document_id,revision_id,source_modified_at,content_digest,
          parser_version,parsed_problem_count)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(document_id,revision_id) DO NOTHING`,
      [snapshot.documentId, snapshot.revisionId, snapshot.modifiedTime, snapshot.contentDigest,
        snapshot.parserVersion, snapshot.problems.length]);
    const revision = await client.query(
      `SELECT content_digest FROM document_revisions WHERE document_id=$1 AND revision_id=$2`,
      [snapshot.documentId, snapshot.revisionId]);
    if (revision.rowCount !== 1 || revision.rows[0].content_digest !== snapshot.contentDigest) {
      throw new Error("revision content digest mismatch");
    }
    const incomingKeys = snapshot.problems.map((problem) => problem.stableKey);
    const current = await client.query(
      `SELECT p.stable_key AS "stableKey", COALESCE(m.source_locator,p.source_ref) AS "sourceLocator",
              p.current_problem_version_id AS "currentVersionId", v.source_version AS "sourceVersion",
              v.source_order AS "sourceOrder", v.stage, v.unit_id AS "unitId",
              v.max_points AS "maxPoints", v.prompt_digest AS "promptDigest",
              v.answer_digest AS "answerDigest", v.explanation_digest AS "explanationDigest",
              v.grading_key_version AS "gradingKeyVersion",
              v.selection_metadata AS "selectionMetadata",
              m.document_id AS "mappedDocumentId"
         FROM problems p
         JOIN problem_versions v ON v.version_id=p.current_problem_version_id
         LEFT JOIN problem_source_map m ON m.subject_id=p.subject_id AND m.stable_key=p.stable_key AND m.active=true
        WHERE p.subject_id=$1
          AND (p.stable_key=ANY($2::text[]) OR m.document_id=$3
               OR ($4::text IS NOT NULL AND p.stable_key LIKE $4))`,
      [SUBJECT, incomingKeys, snapshot.documentId,
        snapshot.sourceId ? snapshot.sourceId + "|%" : null]);
    const candidates = classifyDocumentSnapshot(snapshot.problems, current.rows, snapshot.documentId);
    const counts = Object.fromEntries(["NEW", "MODIFIED", "UNCHANGED", "DUPLICATE", "DELETE_CANDIDATE"]
      .map((kind) => [kind, candidates.filter((item) => item.kind === kind).length]));
    const run = await client.query(
      `INSERT INTO sync_runs(document_id,revision_id,request_id,request_digest,detected_counts)
       VALUES($1,$2,$3,$4,$5) RETURNING sync_run_id`,
      [snapshot.documentId, snapshot.revisionId, requestId, requestDigest, JSON.stringify(counts)]);
    for (const item of candidates) {
      await client.query(
        `INSERT INTO sync_candidates(sync_run_id,subject_id,stable_key,candidate_kind,candidate_digest,
          prompt_changed,answer_changed,explanation_changed,candidate_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.rows[0].sync_run_id, SUBJECT, item.stableKey, item.kind, item.candidateDigest,
          item.promptChanged, item.answerChanged, item.explanationChanged, JSON.stringify(item.payload)]);
    }
    await client.query(
      `UPDATE source_documents SET current_revision_id=$1,current_content_digest=$2,last_checked_at=now()
        WHERE document_id=$3`, [snapshot.revisionId, snapshot.contentDigest, snapshot.documentId]);
    await client.query(
      `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,request_id,payload_digest,metadata)
       VALUES($1,$2,'DOCS_SYNC_DETECT','sync_run',$3,$4,$5,$6)`,
      [actor, SUBJECT, run.rows[0].sync_run_id, requestId, requestDigest, JSON.stringify(counts)]);
    return { ok: true, replayed: false, syncRunId: run.rows[0].sync_run_id, counts,
      candidates: await loadCandidates(client, run.rows[0].sync_run_id) };
  });
}

export async function approveSyncCandidate(pool, input) {
  const candidateId = required(input.candidateId, "candidateId");
  const actorId = required(input.actorId, "actorId");
  const requestId = required(input.requestId, "requestId");
  const approvalType = required(input.approvalType, "approvalType");
  if (!new Set(["CONTENT", "GRADING"]).has(approvalType)) throw new Error("invalid approvalType");
  const reason = required(input.reason, "reason");
  return inTransaction(pool, async (client) => {
    const candidate = await client.query(
      `SELECT candidate_kind,answer_changed,explanation_changed,state
         FROM sync_candidates WHERE candidate_id=$1 FOR UPDATE`, [candidateId]);
    if (candidate.rowCount !== 1) throw new Error("candidate not found");
    if (candidate.rows[0].candidate_kind === "DUPLICATE") throw new Error("duplicate candidate cannot be approved");
    if (candidate.rows[0].state === "REJECTED") throw new Error("rejected candidate cannot be approved");
    if (candidate.rows[0].state === "APPLIED") throw new Error("applied candidate cannot be approved");
    if (approvalType === "GRADING" && !candidate.rows[0].answer_changed && !candidate.rows[0].explanation_changed) {
      throw new Error("grading approval is not required");
    }
    const result = await client.query(
      `INSERT INTO sync_approvals(candidate_id,approval_type,actor_id,request_id,reason)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(candidate_id,approval_type) DO NOTHING RETURNING approval_id`,
      [candidateId, approvalType, actorId, requestId, reason]);
    await client.query("UPDATE sync_candidates SET state='APPROVED' WHERE candidate_id=$1 AND state='PENDING'", [candidateId]);
    return { ok: true, replayed: result.rowCount === 0, candidateId, approvalType };
  });
}

async function requireApprovals(client, row) {
  const approvals = await client.query(
    `SELECT approval_type FROM sync_approvals WHERE candidate_id=$1`, [row.candidate_id]);
  const types = new Set(approvals.rows.map((item) => item.approval_type));
  if (!types.has("CONTENT")) throw new Error("content approval required");
  if ((row.answer_changed || row.explanation_changed) && !types.has("GRADING")) {
    throw new Error("separate grading approval required");
  }
}

export async function applyApprovedSyncCandidate(pool, input) {
  const candidateId = required(input.candidateId, "candidateId");
  const actorId = required(input.actorId, "actorId");
  return inTransaction(pool, async (client) => {
    const candidate = await client.query(
      `SELECT c.*,r.document_id,r.revision_id FROM sync_candidates c
         JOIN sync_runs r ON r.sync_run_id=c.sync_run_id
        WHERE c.candidate_id=$1 FOR UPDATE`, [candidateId]);
    if (candidate.rowCount !== 1) throw new Error("candidate not found");
    const row = candidate.rows[0];
    if (row.state === "APPLIED") return { ok: true, replayed: true, candidateId };
    if (row.state !== "APPROVED") throw new Error("candidate approval state required");
    if (row.candidate_kind === "DUPLICATE") throw new Error("duplicate candidate cannot be applied");
    if (row.candidate_kind !== "NEW") {
      const current = await client.query(
        `SELECT current_problem_version_id FROM problems
          WHERE subject_id=$1 AND stable_key=$2 FOR UPDATE`, [SUBJECT, row.stable_key]);
      if (current.rowCount !== 1 ||
          String(current.rows[0].current_problem_version_id) !==
            String(row.candidate_payload.baseVersionId || row.candidate_payload.currentVersionId)) {
        throw new Error("stale sync candidate rejected");
      }
    }
    await requireApprovals(client, row);
    const payload = row.candidate_payload;
    if (row.candidate_kind === "DELETE_CANDIDATE") {
      await client.query(
        `UPDATE problem_source_map SET active=false,updated_at=now()
          WHERE subject_id=$1 AND stable_key=$2 AND document_id=$3`,
        [SUBJECT, row.stable_key, row.document_id]);
      await client.query("UPDATE problems SET published=false WHERE subject_id=$1 AND stable_key=$2",
        [SUBJECT, row.stable_key]);
    } else if (row.candidate_kind !== "UNCHANGED") {
      if (row.candidate_kind === "MODIFIED" &&
          (row.answer_changed || row.explanation_changed) && payload.gradingKeyVersion) {
        const key = await client.query(
          `SELECT 1 FROM private_grading_keys
            WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3
              AND verification_state='verified' AND active_for_grading=true`,
          [SUBJECT, row.stable_key, payload.gradingKeyVersion]);
        if (key.rowCount !== 1) throw new Error("verified grading generation required before activation");
      }
      if (row.candidate_kind === "NEW") {
        await client.query(
          `INSERT INTO problems(subject_id,stable_key,unit_id,stage,source_order,source_ref,source_version,
             prompt_text,max_points,published,selection_metadata,content_digest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11)`,
          [SUBJECT, row.stable_key, payload.unitId, payload.stage, payload.sourceOrder,
            `gdoc:${row.document_id}#${payload.sourceLocator}`, payload.sourceVersion, payload.promptText,
            payload.maxPoints, JSON.stringify(payload.selectionMetadata), payload.promptDigest]);
      }
      const version = await client.query(
        `INSERT INTO problem_versions(subject_id,stable_key,source_document_id,source_revision_id,source_version,
           stage,unit_id,source_order,prompt_text,max_points,prompt_digest,answer_digest,explanation_digest,
           grading_key_version,selection_metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT(subject_id,stable_key,source_version) DO NOTHING RETURNING version_id`,
        [SUBJECT, row.stable_key, row.document_id, row.revision_id, payload.sourceVersion, payload.stage,
          payload.unitId, payload.sourceOrder, payload.promptText, payload.maxPoints, payload.promptDigest,
          payload.answerDigest, payload.explanationDigest, payload.gradingKeyVersion,
          JSON.stringify(payload.selectionMetadata)]);
      let versionId = version.rows[0]?.version_id;
      if (!versionId) {
        const existing = await client.query(
          `SELECT version_id,prompt_digest,answer_digest,explanation_digest FROM problem_versions
            WHERE subject_id=$1 AND stable_key=$2 AND source_version=$3`,
          [SUBJECT, row.stable_key, payload.sourceVersion]);
        if (existing.rowCount !== 1 || existing.rows[0].prompt_digest !== payload.promptDigest ||
            existing.rows[0].answer_digest !== payload.answerDigest ||
            existing.rows[0].explanation_digest !== payload.explanationDigest) {
          throw new Error("source version reuse with different content rejected");
        }
        versionId = existing.rows[0].version_id;
      }
      await client.query(
        `UPDATE problems SET unit_id=$1,stage=$2,source_order=$3,source_ref=$4,source_version=$5,
           prompt_text=$6,max_points=$7,selection_metadata=$8,content_digest=$9,current_problem_version_id=$10,
           published=CASE WHEN $13 THEN false ELSE published END
          WHERE subject_id=$11 AND stable_key=$12`,
        [payload.unitId, payload.stage, payload.sourceOrder, `gdoc:${row.document_id}#${payload.sourceLocator}`,
          payload.sourceVersion, payload.promptText, payload.maxPoints, JSON.stringify(payload.selectionMetadata),
          payload.promptDigest, versionId, SUBJECT, row.stable_key, row.prompt_changed]);
      await client.query(
        `INSERT INTO problem_source_map(subject_id,stable_key,document_id,source_locator,current_version_id,active)
         VALUES($1,$2,$3,$4,$5,true)
         ON CONFLICT(subject_id,stable_key) DO UPDATE SET document_id=EXCLUDED.document_id,
           source_locator=EXCLUDED.source_locator,current_version_id=EXCLUDED.current_version_id,
           active=true,updated_at=now()`,
        [SUBJECT, row.stable_key, row.document_id, payload.sourceLocator, versionId]);
    }
    await client.query("UPDATE sync_candidates SET state='APPLIED',applied_at=now() WHERE candidate_id=$1", [candidateId]);
    await client.query(
      `INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,payload_digest,metadata)
       VALUES($1,$2,'DOCS_SYNC_APPLY','sync_candidate',$3,$4,$5)`,
      [actorId, SUBJECT, candidateId, row.candidate_digest,
        JSON.stringify({ kind: row.candidate_kind, documentId: row.document_id, revisionId: row.revision_id })]);
    return { ok: true, replayed: false, candidateId, kind: row.candidate_kind };
  });
}

export async function fetchGoogleDocReadOnly({ documentId, accessToken, fetchImpl = fetch }) {
  const id = encodeURIComponent(required(documentId, "documentId"));
  const token = required(accessToken, "accessToken");
  const response = await fetchImpl(`https://docs.googleapis.com/v1/documents/${id}?includeTabsContent=true`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Google Docs read failed: ${response.status}`);
  const document = await response.json();
  if (document.documentId !== documentId) throw new Error("Google Docs document id mismatch");
  return document;
}
