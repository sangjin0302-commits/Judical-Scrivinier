// Synthetic only, fresh localhost disposable database. No external DB permitted.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {gradingAad,createPostgresExecutor} from "../db/postgres-adapter.mjs";
import {publishP2ScoreAllocation,p2AllocationRequestDigest} from "../db/publish-p2-score-allocation.mjs";
const url=new URL(process.env.TEST_DATABASE_URL||"http://invalid");
if(!["127.0.0.1","localhost"].includes(url.hostname)||url.port!=="55533"||
    !/^exam_flow_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error("Fresh localhost55533 exam_flow_* required");
const pool=new pg.Pool({connectionString:url.toString(),max:3});
const encryptionKey=crypto.randomBytes(32),encryptionKeyId="synthetic-allocation";
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const input={subjectId:"CIVIL",sourceCaseKey:"SRC-CIV-005|2020-제26회-문1",items:[]};
const options={encryptionKey,encryptionKeyId};
try{
  assert.equal((await pool.query("SELECT to_regclass('public.problems') AS name")).rows[0].name,null);
  for(const migration of ["0001_learning_ledger.sql","0002_grading_key_rotation.sql","0004_google_docs_sync.sql",
    "0008_exam_selection_indexes.sql","0009_exam_review_due.sql"]){
    await pool.query(await readFile(new URL("../db/migrations/"+migration,import.meta.url),"utf8"));
  }
  await pool.query("INSERT INTO subjects(subject_id,name) VALUES('CIVIL','Synthetic')");
  await pool.query("INSERT INTO source_documents(document_id,subject_id,title) VALUES('synthetic','CIVIL','Synthetic')");
  await pool.query(`INSERT INTO document_revisions(document_id,revision_id,content_digest,parser_version,parsed_problem_count)
    VALUES('synthetic','r1','synthetic','test',9)`);
  for(let position=1;position<=9;position++){
    const stableKey=input.sourceCaseKey+"-소문항"+position,prompt="Synthetic source "+position;
    const maximum=position<=4?20:15;
    await pool.query(`INSERT INTO problems(subject_id,stable_key,stage,source_order,source_ref,source_version,prompt_text,max_points,published,content_digest)
      VALUES('CIVIL',$1,'P2',$2,'synthetic','v1',$3,$4,true,$5)`,[stableKey,position,prompt,maximum,hash(prompt)]);
    const version=(await pool.query(`INSERT INTO problem_versions(subject_id,stable_key,source_document_id,source_revision_id,
      source_version,stage,source_order,prompt_text,max_points,prompt_digest)
      VALUES('CIVIL',$1,'synthetic','r1','v1','P2',$2,$3,$4,$5) RETURNING version_id`,
      [stableKey,position,prompt,maximum,hash(prompt)])).rows[0].version_id;
    await pool.query("UPDATE problems SET current_problem_version_id=$1 WHERE stable_key=$2",[version,stableKey]);
    await pool.query(`INSERT INTO problem_source_map(subject_id,stable_key,document_id,source_locator,current_version_id)
      VALUES('CIVIL',$1,'synthetic',$2,$3)`,[stableKey,"item-"+position,version]);
    const plaintext=JSON.stringify({answer:"A",rubric:"A"}),iv=crypto.randomBytes(12);
    const cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey,iv);
    cipher.setAAD(gradingAad("CIVIL",stableKey,"v1",encryptionKeyId));
    const body=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    await pool.query(`INSERT INTO private_grading_keys(subject_id,stable_key,key_version,encryption_key_id,
      encrypted_payload,payload_digest,verification_state,active_for_grading)
      VALUES('CIVIL',$1,'v1',$2,$3,$4,'verified',true)`,
      [stableKey,encryptionKeyId,Buffer.concat([iv,cipher.getAuthTag(),body]),hash(plaintext)]);
    input.items.push({position,stableKey,expectedProblemVersionId:version,expectedPromptDigest:hash(prompt),
      expectedKeyVersion:"v1",expectedPayloadDigest:hash(plaintext),expectedOldMaximum:maximum,
      originalGroupMaximum:position<=4?20:15,allocatedLearningMaximum:position===5||position===6?7.5:5});
  }
  input.approval={approved:true,reviewId:"synthetic-allocation-review",reviewerId:"synthetic-reviewer",
    reviewedAt:"2026-01-01T00:00:00Z",evidenceDigest:hash("synthetic-evidence"),
    allocationPolicy:"synthetic-approved-equal",requestDigest:p2AllocationRequestDigest(input)};
  const executor=createPostgresExecutor({pool,env:{GRADING_KEY_BASE64:encryptionKey.toString("base64"),
    GRADING_ENCRYPTION_KEY_ID:encryptionKeyId}});
  const oldContext={ownerId:"synthetic-old-owner"},newContext={ownerId:"synthetic-new-owner"};
  const oldSet=await executor("issueCivilP2",{requestId:"old-issue",mode:"문제지정",
    specificKeys:[input.items[0].stableKey]},oldContext);
  const answers=[{key:input.items[0].stableKey,text:"A"}];
  const oldPrepare=await executor("prepareCivilP2Grade",{setId:oldSet.setId,answers},oldContext);
  assert.equal(oldPrepare.rubrics[0].maxPoints,20);
  const protectedSnapshot=async()=>{
    const data={};
    for(const table of ["source_documents","document_revisions","original_answers","submissions","issue_sets","issue_set_items","p2_grades"]){
      data[table]=(await pool.query("SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "+table+" t")).rows[0].digest;
    }
    data.oldVersions=(await pool.query("SELECT to_jsonb(v) AS row FROM problem_versions v WHERE source_version='v1' ORDER BY stable_key")).rows;
    data.oldKeys=(await pool.query("SELECT stable_key,payload_digest,encode(encrypted_payload,'hex') AS cipher FROM private_grading_keys WHERE key_version='v1' ORDER BY stable_key")).rows;
    return JSON.stringify(data);
  };
  const before=await protectedSnapshot();
  assert.equal((await publishP2ScoreAllocation(pool,input,options)).dryRun,true);
  assert.equal(await protectedSnapshot(),before);
  const failPool={async connect(){const c=await pool.connect();return {release:()=>c.release(),
    query:(sql,args)=>sql.includes("INSERT INTO audit_events")?Promise.reject(Error("synthetic final audit failure")):c.query(sql,args)};}};
  await assert.rejects(publishP2ScoreAllocation(failPool,input,{...options,dryRun:false}),/final audit failure/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM problem_versions")).rows[0].n,9);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM private_grading_keys")).rows[0].n,9);
  assert.equal(await protectedSnapshot(),before);
  const applied=await Promise.all([1,2].map(()=>publishP2ScoreAllocation(pool,input,{...options,dryRun:false})));
  assert.equal(applied.filter(r=>r.replayed).length,1);
  assert.equal(applied.filter(r=>r.inserted===9).length,1);
  assert.equal(await protectedSnapshot(),before);
  assert.equal((await pool.query("SELECT sum(max_points)::numeric AS n FROM problems")).rows[0].n,"50.00");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM private_grading_keys WHERE active_for_grading=true")).rows[0].n,9);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='P2_SCORE_ALLOCATION_PUBLISH'")).rows[0].n,1);
  const oldAgain=await executor("prepareCivilP2Grade",{setId:oldSet.setId,answers},oldContext);
  assert.equal(oldAgain.rubrics[0].maxPoints,20);
  const newSet=await executor("issueCivilP2",{requestId:"new-issue",mode:"문제지정",
    specificKeys:[input.items[0].stableKey]},newContext);
  const newPrepare=await executor("prepareCivilP2Grade",{setId:newSet.setId,answers},newContext);
  assert.equal(newPrepare.rubrics[0].maxPoints,5);
  console.log(JSON.stringify({ok:true,dryRunNoWrites:true,lateFailureRollsBackAllNine:true,
    concurrentAppendReplay:true,oldSnapshotsAndCiphertextPreserved:true,sourceDocsAndLearnerHistoryPreserved:true,
    oldPreparedMaximum:20,newPreparedLearningMaximum:5,newGroupTotal:50,oneActiveKeyPerItem:true}));
}finally{encryptionKey.fill(0);await pool.end();}
