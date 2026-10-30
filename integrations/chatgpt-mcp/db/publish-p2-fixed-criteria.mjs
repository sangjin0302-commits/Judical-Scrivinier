import crypto from "node:crypto";
import { decryptGradingPayload, gradingAad } from "./postgres-adapter.mjs";
import { createP2CriteriaManifest, validateP2FixedCriteria, validateP2DecisionRubric } from "./p2-fixed-criteria.mjs";
export { validateP2DecisionRubric } from "./p2-fixed-criteria.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function text(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error("invalid publication identity");
  return value.trim();
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid publication digest");
  return value;
}

export const p2PublicationDigest = value => hash(canonical(value));

/** Trusted maintenance caller only; not an MCP tool. Evidence is an audit binding,
 * not a signature or a substitute for the caller checking the actual review record.
 * No credentials are loaded here. dryRun is default; activation is separately explicit.
 */
export async function publishP2FixedCriteria(pool, input, {
  encryptionKey, encryptionKeyId, dryRun = true, activate = false,
} = {}) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error("existing encryption key required");
  if (typeof dryRun !== "boolean" || typeof activate !== "boolean") throw new Error("publication options must be boolean");
  const subjectId = text(input.subjectId), stableKey = text(input.stableKey);
  const keyId = text(encryptionKeyId), originalKeyVersion = text(input.expectedKeyVersion);
  const originalPayloadDigest = digest(input.expectedPayloadDigest);
  const problemVersionId = text(input.expectedProblemVersionId), problemDigest = digest(input.expectedProblemDigest);
  const evidence = input.approvalEvidence;
  if (evidence?.approved !== true) throw new Error("review approval evidence required");
  const approval = { reviewId: text(evidence.reviewId), reviewerId: text(evidence.reviewerId),
    reviewedAt: text(evidence.reviewedAt), criteriaDigest: digest(evidence.criteriaDigest),
    decisionRubricDigest: digest(evidence.decisionRubricDigest),
    reviewEvidenceDigest: digest(evidence.reviewEvidenceDigest),
    originalPayloadDigest: digest(evidence.originalPayloadDigest), problemDigest: digest(evidence.problemDigest) };
  if (!Number.isFinite(Date.parse(approval.reviewedAt)) || approval.originalPayloadDigest !== originalPayloadDigest ||
      approval.problemDigest !== problemDigest || approval.criteriaDigest !== input.manifest?.criteriaDigest) {
    throw new Error("review approval binding mismatch");
  }
  const review = input.reviewEvidence;
  if (review?.sourceOnly !== true || review.learnerAnswersProvidedToRubricReview !== false ||
      review.duplicateGroups !== 0 || review.unsupportedElements !== 0 || review.requiresRevision !== false) {
    throw new Error("source-only review is incomplete or requires revision");
  }
  const reviewEvidence = { sourceOnly: true, learnerAnswersProvidedToRubricReview: false,
    criteriaFile: text(review.criteriaFile), criteriaFileDigest: digest(review.criteriaFileDigest),
    auditFile: text(review.auditFile), auditFileDigest: digest(review.auditFileDigest),
    duplicateGroups: 0, unsupportedElements: 0, requiresRevision: false };
  if (p2PublicationDigest(reviewEvidence) !== approval.reviewEvidenceDigest) throw new Error("review evidence digest mismatch");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hash(canonical(["p2-fixed-criteria", subjectId, stableKey]))]);
    const problem = await client.query(`SELECT p.stage,p.current_problem_version_id,v.prompt_digest AS content_digest
      FROM problems p JOIN problem_versions v ON v.version_id=p.current_problem_version_id
        AND v.subject_id=p.subject_id AND v.stable_key=p.stable_key
      WHERE p.subject_id=$1 AND p.stable_key=$2 FOR UPDATE OF p,v`, [subjectId, stableKey]);
    if (problem.rowCount !== 1 || problem.rows[0].stage !== "P2" ||
        problem.rows[0].current_problem_version_id !== problemVersionId || problem.rows[0].content_digest !== problemDigest) {
      throw new Error("current problem snapshot changed");
    }
    const original = await client.query(`SELECT encrypted_payload,payload_digest,verification_state,active_for_grading
      FROM private_grading_keys WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3
        AND encryption_key_id=$4 FOR UPDATE`, [subjectId, stableKey, originalKeyVersion, keyId]);
    if (original.rowCount !== 1 || original.rows[0].verification_state !== "verified" ||
        original.rows[0].payload_digest !== originalPayloadDigest) throw new Error("original grading snapshot mismatch");
    const source = decryptGradingPayload(original.rows[0].encrypted_payload, encryptionKey,
      gradingAad(subjectId, stableKey, originalKeyVersion, keyId), originalPayloadDigest);
    const official = { modelAnswer: source.answer, rubric: source.rubric };
    validateP2FixedCriteria(input.manifest, { elements: input.manifest?.requiredElements }, official);
    const manifest = createP2CriteriaManifest(input.manifest.requiredElements, official);
    const fixedDecisionRubric = validateP2DecisionRubric(input.decisionRubric, manifest, official);
    if (p2PublicationDigest(fixedDecisionRubric) !== approval.decisionRubricDigest) {
      throw new Error("review decision rubric digest mismatch");
    }
    const payload = { ...source, fixedCriteriaManifest: manifest, fixedDecisionRubric,
      fixedCriteriaReviewEvidence: reviewEvidence, fixedCriteriaApproval: {
      ...approval, originalKeyVersion, originalEncryptionKeyId: keyId, problemVersionId,
    } };
    const plaintext = canonical(payload), payloadDigest = hash(plaintext);
    const keyVersion = `criteria-${payloadDigest.slice(0, 24)}`;
    if (keyVersion === originalKeyVersion) throw new Error("publication must append a distinct key version");
    const existing = await client.query(`SELECT encrypted_payload,payload_digest,verification_state,active_for_grading
      FROM private_grading_keys WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3
        AND encryption_key_id=$4 FOR UPDATE`, [subjectId, stableKey, keyVersion, keyId]);
    if (existing.rowCount > 1) throw new Error("ambiguous published key version");
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.payload_digest !== payloadDigest || row.verification_state !== "verified") throw new Error("published key conflict");
      decryptGradingPayload(row.encrypted_payload, encryptionKey,
        gradingAad(subjectId, stableKey, keyVersion, keyId), payloadDigest);
    }
    const active = await client.query(`SELECT key_version,encryption_key_id FROM private_grading_keys
      WHERE subject_id=$1 AND stable_key=$2 AND active_for_grading=true FOR UPDATE`, [subjectId, stableKey]);
    if (active.rowCount !== 1 || active.rows[0].encryption_key_id !== keyId ||
        ![originalKeyVersion, keyVersion].includes(active.rows[0].key_version)) {
      throw new Error("active grading snapshot changed");
    }
    const alreadyActive = active.rows[0].key_version === keyVersion;
    const replayed = existing.rowCount === 1 && (!activate || alreadyActive);
    const summary = { ok: true, dryRun, replayed, keyVersion, payloadDigest,
      criteriaDigest: manifest.criteriaDigest, requiredElementCount: manifest.requiredElements.length,
      active: alreadyActive || activate, inserted: !existing.rowCount };
    if (dryRun) { await client.query("ROLLBACK"); return { ...summary, active: alreadyActive, inserted: false, wouldInsert: !existing.rowCount, wouldActivate: activate && !alreadyActive }; }
    if (!existing.rowCount) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(gradingAad(subjectId, stableKey, keyVersion, keyId));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
      decryptGradingPayload(encrypted, encryptionKey, gradingAad(subjectId, stableKey, keyVersion, keyId), payloadDigest);
      await client.query(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,encryption_key_id,
        encrypted_payload,payload_digest,verification_state,active_for_grading,verified_at)
        VALUES($1,$2,$3,$4,$5,$6,'verified',false,now())`,
      [subjectId, stableKey, keyVersion, keyId, encrypted, payloadDigest]);
    }
    if (activate && !alreadyActive) {
      const deactivated = await client.query(`UPDATE private_grading_keys SET active_for_grading=false
        WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3 AND encryption_key_id=$4 AND active_for_grading=true`,
      [subjectId, stableKey, originalKeyVersion, keyId]);
      if (deactivated.rowCount !== 1) throw new Error("activation source changed");
      const activated = await client.query(`UPDATE private_grading_keys SET active_for_grading=true
        WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3 AND encryption_key_id=$4 AND active_for_grading=false`,
      [subjectId, stableKey, keyVersion, keyId]);
      if (activated.rowCount !== 1) throw new Error("activation target changed");
    }
    if (!replayed) await client.query(`INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,payload_digest,metadata)
      VALUES($1,$2,'P2_FIXED_CRITERIA_PUBLISH','grading_key',$3,$4,$5)`,
    [approval.reviewerId, subjectId, keyVersion, payloadDigest, JSON.stringify({ reviewId: approval.reviewId,
      criteriaDigest: manifest.criteriaDigest, originalPayloadDigest, problemVersionId, activate })]);
    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
