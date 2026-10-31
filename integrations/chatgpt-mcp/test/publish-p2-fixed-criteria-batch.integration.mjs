import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {gradingAad} from "../db/postgres-adapter.mjs";
import {createP2CriteriaManifest} from "../db/p2-fixed-criteria.mjs";
import {p2PublicationDigest} from "../db/publish-p2-fixed-criteria.mjs";
import {publishP2FixedCriteriaBatch} from "../db/publish-p2-fixed-criteria-batch.mjs";
const url=new URL(process.env.TEST_DATABASE_URL||"http://invalid");
if(!["127.0.0.1","localhost"].includes(url.hostname)||url.port!=="55533"||
    !/^exam_flow_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error("Disposable localhost55533 exam_flow_* required");
const pool=new pg.Pool({connectionString:url.toString(),max:3});
const encryptionKey=crypto.randomBytes(32),encryptionKeyId="synthetic-batch";
const hash=v=>crypto.createHash("sha256").update(v).digest("hex");
const inputs=[],options={encryptionKey,encryptionKeyId,activate:true};
try{
  assert.equal((await pool.query("SELECT to_regclass('public.problems') AS name")).rows[0].name,null);
  for(const name of ["0001_learning_ledger.sql","0002_grading_key_rotation.sql","0004_google_docs_sync.sql"])
    await pool.query(await readFile(new URL("../db/migrations/"+name,import.meta.url),"utf8"));
  await pool.query("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic')");
  await pool.query("INSERT INTO source_documents(document_id,subject_id,title) VALUES('synthetic','CIVIL','Synthetic')");
  await pool.query("INSERT INTO document_revisions(document_id,revision_id,content_digest,parser_version,parsed_problem_count) VALUES('synthetic','r1','synthetic','test',8)");
  for(let i=1;i<=8;i++){
    const stableKey="SYNTHETIC|case-"+i,prompt="Synthetic "+i,plain=JSON.stringify({answer:"A",rubric:"A"});
    await pool.query("INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,prompt_text,max_points,published,content_digest) VALUES('CIVIL',$1,'P2',$2,'synthetic','v1',$3,10,true,$4)",[stableKey,i,prompt,hash(prompt)]);
    const id=(await pool.query("INSERT INTO problem_versions(subject_id,stable_key,source_document_id,source_revision_id,source_version,stage,source_order,prompt_text,max_points,prompt_digest) VALUES('CIVIL',$1,'synthetic','r1','v1','P2',$2,$3,10,$4) RETURNING version_id",[stableKey,i,prompt,hash(prompt)])).rows[0].version_id;
    await pool.query("UPDATE problems SET current_problem_version_id=$1 WHERE stable_key=$2",[id,stableKey]);
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey,iv);
    cipher.setAAD(gradingAad("CIVIL",stableKey,"v1",encryptionKeyId));
    const body=Buffer.concat([cipher.update(plain),cipher.final()]);
    await pool.query("INSERT INTO private_grading_keys(subject_id,stable_key,key_version,encryption_key_id,encrypted_payload,payload_digest,verification_state,active_for_grading) VALUES('CIVIL',$1,'v1',$2,$3,$4,'verified',true)",[stableKey,encryptionKeyId,Buffer.concat([iv,cipher.getAuthTag(),body]),hash(plain)]);
    const manifest=createP2CriteriaManifest([{category:"LAW",criterion:"A",modelExcerpt:"A"}],{modelAnswer:"A",rubric:"A"});
    const decisionRubric={elements:[{...manifest.requiredElements[0],explanation:"Synthetic",requiredPropositions:["A"],matchCondition:"A",partialCondition:"Partial A",errorCondition:"Contradiction",missingCondition:"Absent"}],
      decompositionRationale:"Synthetic",changesFromPrevious:"",unresolvedAmbiguities:[]};
    const reviewEvidence={sourceOnly:true,learnerAnswersProvidedToRubricReview:false,criteriaFile:"synthetic",criteriaFileDigest:hash("criteria"),auditFile:"synthetic",auditFileDigest:hash("audit"),duplicateGroups:0,unsupportedElements:0,requiresRevision:false};
    inputs.push({subjectId:"CIVIL",stableKey,expectedKeyVersion:"v1",expectedPayloadDigest:hash(plain),
      expectedProblemVersionId:id,expectedProblemDigest:hash(prompt),manifest,decisionRubric,reviewEvidence,
      approvalEvidence:{approved:true,reviewId:"synthetic-batch-review",reviewerId:"synthetic-reviewer",reviewedAt:"2026-01-01T00:00:00Z",
        criteriaDigest:manifest.criteriaDigest,originalPayloadDigest:hash(plain),problemDigest:hash(prompt),
        decisionRubricDigest:p2PublicationDigest(decisionRubric),reviewEvidenceDigest:p2PublicationDigest(reviewEvidence)}});
  }
  const snapshot=async client=>{
    const state={};
    for(const table of ["problems","problem_versions","source_documents","document_revisions","issue_sets","issue_set_items","original_answers","p2_grades"]){
      state[table]=(await client.query("SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "+table+" t")).rows[0];
    }
    state.oldKeys=(await client.query("SELECT stable_key,payload_digest,encode(encrypted_payload,'hex') AS cipher FROM private_grading_keys WHERE key_version='v1' ORDER BY stable_key")).rows;
    return state;
  };
  const before=await snapshot(pool);
  const dry=await publishP2FixedCriteriaBatch(pool,inputs,{...options,invariantSnapshot:snapshot});
  assert.equal(dry.dryRun,true);assert.equal(dry.inserted,0);
  let attemptedAudits=0;
  const failPool={async connect(){const c=await pool.connect();return {release:()=>c.release(),query:(sql,v)=>{
    if(sql.includes("INSERT INTO audit_events")&&++attemptedAudits===8)throw Error("synthetic eighth item failure");
    return c.query(sql,v);
  }};}};
  await assert.rejects(publishP2FixedCriteriaBatch(failPool,inputs,{...options,dryRun:false,invariantSnapshot:snapshot}),/eighth item failure/);
  assert.equal(attemptedAudits,8);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM private_grading_keys")).rows[0].n,8);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n,0);
  assert.deepEqual(await snapshot(pool),before);
  let calls=0;
  await assert.rejects(publishP2FixedCriteriaBatch(pool,inputs,{...options,dryRun:false,
    invariantSnapshot:async()=>({different:++calls})}),/invariant changed/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM private_grading_keys")).rows[0].n,8);
  const results=await Promise.all([inputs,[...inputs].reverse()].map(batch=>publishP2FixedCriteriaBatch(pool,batch,
    {...options,dryRun:false,invariantSnapshot:snapshot})));
  assert.deepEqual(results.map(r=>r.inserted).sort((a,b)=>a-b),[0,8]);
  assert.deepEqual(results.map(r=>r.replayed).sort((a,b)=>a-b),[0,8]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM private_grading_keys WHERE active_for_grading=true")).rows[0].n,8);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n,8);
  assert.deepEqual(await snapshot(pool),before);
  console.log(JSON.stringify({ok:true,dryRunNoWrites:true,eighthItemFailureRolledBackAll:true,
    invariantFailureRolledBackAll:true,reverseOrderConcurrentReplay:true,inserted:8,active:8,protectedSnapshotsPreserved:true}));
}finally{encryptionKey.fill(0);await pool.end();}
