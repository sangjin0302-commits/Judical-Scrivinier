import crypto from "node:crypto";
import { decryptGradingPayload, gradingAad } from "./postgres-adapter.mjs";
import { p2PublicationDigest } from "./publish-p2-fixed-criteria.mjs";
import { p2ScoreBasisDigest, validateP2ScoreGroup } from "./p2-score-basis.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
function fail() { throw new Error("P2 allocation publication binding mismatch"); }
function text(v) { if (typeof v !== "string" || !v.trim() || v.length > 500) fail(); return v; }
function digest(v) { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail(); return v; }
function uuid(v) { const h=hash(v); return h.slice(0,8)+"-"+h.slice(8,12)+"-5"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32); }
const distribution = [5,5,5,5,7.5,7.5,5,5,5];
const groupNumber = position => position <= 4 ? 1 : position <= 6 ? 2 : 3;
const groupMaximum = position => position <= 4 ? 20 : 15;

export function p2AllocationRequestDigest(input) {
  return p2PublicationDigest({subjectId:input.subjectId,sourceCaseKey:input.sourceCaseKey,
    items:[...(input.items??[])].sort((a,b)=>a.position-b.position)});
}

// Trusted maintenance only. Exactly one approved nine-item allocation (20+15+15).
// No endpoint, credentials, source text edits, learner writes, or criteria approval rebinding.
export async function publishP2ScoreAllocation(pool,input,{
  encryptionKey,encryptionKeyId,dryRun=true,
}={}) {
  if(!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32||typeof dryRun!=="boolean") fail();
  if(input.subjectId!=="CIVIL"||!Array.isArray(input.items)||input.items.length!==9) fail();
  const caseKey=text(input.sourceCaseKey),keyId=text(encryptionKeyId);
  const items=[...input.items].sort((a,b)=>a.position-b.position);
  const approval=input.approval;
  if(approval?.approved!==true) fail();
  const review={reviewId:text(approval.reviewId),reviewerId:text(approval.reviewerId),
    reviewedAt:text(approval.reviewedAt),evidenceDigest:digest(approval.evidenceDigest),
    allocationPolicy:text(approval.allocationPolicy),requestDigest:digest(approval.requestDigest)};
  if(!Number.isFinite(Date.parse(review.reviewedAt))||review.requestDigest!==p2AllocationRequestDigest(input)) fail();
  for(let i=0;i<items.length;i++){
    const x=items[i];
    if(x.position!==i+1||x.stableKey!==caseKey+"-소문항"+(i+1)||
        x.allocatedLearningMaximum!==distribution[i]||x.originalGroupMaximum!==groupMaximum(i+1)) fail();
    text(x.expectedProblemVersionId);text(x.expectedKeyVersion);
    digest(x.expectedPromptDigest);digest(x.expectedPayloadDigest);
    if(typeof x.expectedOldMaximum!=="number"||!Number.isFinite(x.expectedOldMaximum)||x.expectedOldMaximum<=0) fail();
  }
  const batchDigest=p2PublicationDigest({requestDigest:review.requestDigest,review,keyId});
  const sourceVersion="allocation-"+batchDigest.slice(0,24);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[hash(canonical(["p2-allocation",caseKey]))]);
    // Same per-source lock namespace/order as the fixed-criteria publisher.
    for(const x of [...items].sort((a,b)=>a.stableKey.localeCompare(b.stableKey))){
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
        [hash(canonical(["p2-fixed-criteria","CIVIL",x.stableKey]))]);
    }
    const plans=[];
    for(const x of items){
      const id=uuid(batchDigest+":"+x.stableKey);
      const current=await client.query(`SELECT p.current_problem_version_id,p.max_points AS current_maximum,
        p.selection_metadata AS current_metadata,p.source_version AS current_source_version,
        v.* FROM problems p JOIN problem_versions v ON v.version_id=$3
          AND v.subject_id=p.subject_id AND v.stable_key=p.stable_key
        WHERE p.subject_id=$1 AND p.stable_key=$2 FOR UPDATE OF p,v`,
        ["CIVIL",x.stableKey,x.expectedProblemVersionId]);
      if(current.rowCount!==1) fail();
      const old=current.rows[0];
      if(old.stage!=="P2"||old.prompt_digest!==x.expectedPromptDigest||
          hash(old.prompt_text)!==x.expectedPromptDigest||Number(old.max_points)!==x.expectedOldMaximum||
          ![x.expectedProblemVersionId,id].includes(old.current_problem_version_id)) fail();
      const key=await client.query(`SELECT encrypted_payload,payload_digest,verification_state
        FROM private_grading_keys WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3
          AND encryption_key_id=$4 FOR UPDATE`,["CIVIL",x.stableKey,x.expectedKeyVersion,keyId]);
      if(key.rowCount!==1||key.rows[0].verification_state!=="verified"||
          key.rows[0].payload_digest!==x.expectedPayloadDigest) fail();
      const payload=decryptGradingPayload(key.rows[0].encrypted_payload,encryptionKey,
        gradingAad("CIVIL",x.stableKey,x.expectedKeyVersion,keyId),x.expectedPayloadDigest);
      // A criteria approval refers to its own immutable problem version.
      // Never rewrite that approval under a score-only authorization.
      if(Object.hasOwn(payload,"fixedCriteriaApproval")||Object.hasOwn(payload,"scoreBasisApproval")) {
        throw new Error("Existing bound approval requires separate review");
      }
      const basis={schemaVersion:1,mode:"allocated_learning",approvalStatus:"approved",
        approvalId:review.reviewId,sourceGroupKey:caseKey+":official-group-"+groupNumber(x.position),
        problemVersionId:id,promptDigest:x.expectedPromptDigest,evidenceDigest:review.evidenceDigest,
        originalGroupMaximum:x.originalGroupMaximum,allocatedLearningMaximum:x.allocatedLearningMaximum,
        allocationPolicy:review.allocationPolicy,allocationApprovalId:review.reviewId};
      const scoreBasisApproval={problemVersionId:id,promptDigest:x.expectedPromptDigest,
        evidenceDigest:review.evidenceDigest,scoreBasisDigest:p2ScoreBasisDigest(basis)};
      const metadata={...old.selection_metadata,scoreBasis:basis};
      const nextPayload={...payload,scoreBasisApproval,scoreBasisPublication:{...review,
        previousProblemVersionId:x.expectedProblemVersionId,previousKeyVersion:x.expectedKeyVersion,
        previousPayloadDigest:x.expectedPayloadDigest,batchDigest}};
      const plaintext=canonical(nextPayload),payloadDigest=hash(plaintext),keyVersion="allocation-"+payloadDigest.slice(0,24);
      const existing=await client.query("SELECT * FROM problem_versions WHERE version_id=$1",[id]);
      if(existing.rowCount){
        const row=existing.rows[0];
        if(row.subject_id!=="CIVIL"||row.stable_key!==x.stableKey||row.source_version!==sourceVersion||
            row.prompt_text!==old.prompt_text||row.prompt_digest!==old.prompt_digest||
            row.stage!==old.stage||row.source_document_id!==old.source_document_id||
            row.source_revision_id!==old.source_revision_id||row.unit_id!==old.unit_id||
            String(row.source_order)!==String(old.source_order)||
            row.answer_digest!==(old.answer_digest??hash(String(payload.answer??"")))||
            row.explanation_digest!==old.explanation_digest||
            Number(row.max_points)!==x.allocatedLearningMaximum||row.grading_key_version!==keyVersion||
            p2PublicationDigest(row.selection_metadata)!==p2PublicationDigest(metadata)) fail();
      }
      const nextKey=await client.query(`SELECT encrypted_payload,payload_digest,verification_state FROM private_grading_keys
        WHERE subject_id=$1 AND stable_key=$2 AND key_version=$3 AND encryption_key_id=$4 FOR UPDATE`,
        ["CIVIL",x.stableKey,keyVersion,keyId]);
      if(nextKey.rowCount){
        if(nextKey.rows[0].payload_digest!==payloadDigest||nextKey.rows[0].verification_state!=="verified") fail();
        decryptGradingPayload(nextKey.rows[0].encrypted_payload,encryptionKey,
          gradingAad("CIVIL",x.stableKey,keyVersion,keyId),payloadDigest);
      }
      const active=await client.query(`SELECT key_version,encryption_key_id FROM private_grading_keys
        WHERE subject_id=$1 AND stable_key=$2 AND active_for_grading=true FOR UPDATE`,["CIVIL",x.stableKey]);
      if(active.rowCount!==1||active.rows[0].encryption_key_id!==keyId) fail();
      const replay=old.current_problem_version_id===id;
      if(replay){
        if(!existing.rowCount||!nextKey.rowCount||active.rows[0].key_version!==keyVersion||
            Number(old.current_maximum)!==x.allocatedLearningMaximum||
            old.current_source_version!==sourceVersion||
            p2PublicationDigest(old.current_metadata)!==p2PublicationDigest(metadata)) fail();
      }else if(existing.rowCount||nextKey.rowCount||active.rows[0].key_version!==x.expectedKeyVersion||
          Number(old.current_maximum)!==x.expectedOldMaximum||
          old.current_source_version!==old.source_version||
          p2PublicationDigest(old.current_metadata)!==p2PublicationDigest(old.selection_metadata)) fail();
      const map=await client.query("SELECT current_version_id FROM problem_source_map WHERE subject_id=$1 AND stable_key=$2 FOR UPDATE",["CIVIL",x.stableKey]);
      if(map.rowCount>1||(map.rowCount&&map.rows[0].current_version_id!==(replay?id:x.expectedProblemVersionId))) fail();
      plans.push({x,old,id,keyVersion,payloadDigest,plaintext,metadata,basis,scoreBasisApproval,replay,hasMap:map.rowCount===1});
    }
    if(plans.some(p=>p.replay)&&!plans.every(p=>p.replay)) fail();
    for(const n of [1,2,3]){
      const group=plans.filter(p=>groupNumber(p.x.position)===n);
      validateP2ScoreGroup(group.map(p=>({basis:p.basis,expected:p.scoreBasisApproval})),
        {sourceGroupKey:group[0].basis.sourceGroupKey,originalGroupMaximum:n===1?20:15,
          problemVersionIds:group.map(p=>p.id)});
    }
    if(plans.reduce((sum,p)=>sum+p.x.allocatedLearningMaximum,0)!==50) fail();
    const replayed=plans.every(p=>p.replay);
    const result={ok:true,dryRun,replayed,count:9,learningTotal:50,originalGroupMaxima:[20,15,15],
      inserted:!dryRun&&!replayed?9:0,batchDigest,items:plans.map(p=>({stableKey:p.x.stableKey,
        problemVersionId:p.id,keyVersion:p.keyVersion,payloadDigest:p.payloadDigest,
        learningMaximum:p.x.allocatedLearningMaximum,scoreBasisDigest:p.scoreBasisApproval.scoreBasisDigest}))};
    if(dryRun||replayed){await client.query("ROLLBACK");return result;}
    for(const p of plans){
      const {x,old}=p;
      await client.query(`INSERT INTO problem_versions(version_id,subject_id,stable_key,source_document_id,
        source_revision_id,source_version,stage,unit_id,source_order,prompt_text,max_points,prompt_digest,
        answer_digest,explanation_digest,grading_key_version,selection_metadata)
        VALUES($1,'CIVIL',$2,$3,$4,$5,'P2',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [p.id,x.stableKey,old.source_document_id,old.source_revision_id,sourceVersion,old.unit_id,
          old.source_order,old.prompt_text,x.allocatedLearningMaximum,old.prompt_digest,
          old.answer_digest??hash(payloadAnswerMarker(p.plaintext)),old.explanation_digest,p.keyVersion,JSON.stringify(p.metadata)]);
      const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey,iv);
      cipher.setAAD(gradingAad("CIVIL",x.stableKey,p.keyVersion,keyId));
      const body=Buffer.concat([cipher.update(p.plaintext,"utf8"),cipher.final()]);
      const bytes=Buffer.concat([iv,cipher.getAuthTag(),body]);
      decryptGradingPayload(bytes,encryptionKey,gradingAad("CIVIL",x.stableKey,p.keyVersion,keyId),p.payloadDigest);
      await client.query(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,encryption_key_id,
        encrypted_payload,payload_digest,verification_state,active_for_grading,verified_at)
        VALUES('CIVIL',$1,$2,$3,$4,$5,'verified',false,now())`,[x.stableKey,p.keyVersion,keyId,bytes,p.payloadDigest]);
      const off=await client.query(`UPDATE private_grading_keys SET active_for_grading=false WHERE subject_id='CIVIL'
        AND stable_key=$1 AND key_version=$2 AND encryption_key_id=$3 AND active_for_grading=true`,
        [x.stableKey,x.expectedKeyVersion,keyId]);
      if(off.rowCount!==1) fail();
      const on=await client.query(`UPDATE private_grading_keys SET active_for_grading=true WHERE subject_id='CIVIL'
        AND stable_key=$1 AND key_version=$2 AND encryption_key_id=$3 AND active_for_grading=false`,[x.stableKey,p.keyVersion,keyId]);
      if(on.rowCount!==1) fail();
      const changed=await client.query(`UPDATE problems SET current_problem_version_id=$1,source_version=$2,
        max_points=$3,selection_metadata=$4 WHERE subject_id='CIVIL' AND stable_key=$5 AND current_problem_version_id=$6`,
        [p.id,sourceVersion,x.allocatedLearningMaximum,JSON.stringify(p.metadata),x.stableKey,x.expectedProblemVersionId]);
      if(changed.rowCount!==1) fail();
      if(p.hasMap) await client.query(`UPDATE problem_source_map SET current_version_id=$1,updated_at=now()
        WHERE subject_id='CIVIL' AND stable_key=$2 AND current_version_id=$3`,[p.id,x.stableKey,x.expectedProblemVersionId]);
    }
    await client.query(`INSERT INTO audit_events(actor_id,subject_id,action,aggregate_type,aggregate_id,payload_digest,metadata)
      VALUES($1,'CIVIL','P2_SCORE_ALLOCATION_PUBLISH','source_case',$2,$3,$4)`,
      [review.reviewerId,caseKey,batchDigest,JSON.stringify({reviewId:review.reviewId,count:9,learningTotal:50})]);
    await client.query("COMMIT");return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}

function payloadAnswerMarker(plaintext) { return String(JSON.parse(plaintext).answer??""); }
