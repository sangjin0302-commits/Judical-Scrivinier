import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {publishP2ScoreAllocation,p2AllocationRequestDigest} from "../db/publish-p2-score-allocation.mjs";
import {gradingAad} from "../db/postgres-adapter.mjs";

const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
function setup(extraPayload={}){
  const encryptionKey=crypto.randomBytes(32),encryptionKeyId="synthetic-key";
  const input={subjectId:"CIVIL",sourceCaseKey:"SYNTHETIC-2020-문1",items:[]};
  let state={versions:{},current:{},keys:{},audits:0};
  for(let position=1;position<=9;position++){
    const stableKey=input.sourceCaseKey+"-소문항"+position,id="old-"+position;
    const prompt="Synthetic "+position,maximum=position<=4?20:15;
    const plaintext=JSON.stringify({answer:"A",rubric:"A",...extraPayload}),iv=crypto.randomBytes(12);
    const cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey,iv);
    cipher.setAAD(gradingAad("CIVIL",stableKey,"v1",encryptionKeyId));
    const body=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    state.keys[stableKey]={v1:{encrypted_payload:Buffer.concat([iv,cipher.getAuthTag(),body]),
      payload_digest:hash(plaintext),verification_state:"verified",active_for_grading:true}};
    state.versions[id]={version_id:id,subject_id:"CIVIL",stable_key:stableKey,source_document_id:"synthetic",
      source_revision_id:"r1",source_version:"v1",stage:"P2",unit_id:null,source_order:position,
      prompt_text:prompt,max_points:maximum,prompt_digest:hash(prompt),answer_digest:null,
      explanation_digest:null,grading_key_version:null,selection_metadata:{}};
    state.current[stableKey]={current_problem_version_id:id,current_maximum:maximum,
      current_metadata:{},current_source_version:"v1"};
    input.items.push({position,stableKey,expectedProblemVersionId:id,expectedPromptDigest:hash(prompt),
      expectedKeyVersion:"v1",expectedPayloadDigest:hash(plaintext),expectedOldMaximum:maximum,
      originalGroupMaximum:position<=4?20:15,allocatedLearningMaximum:position===5||position===6?7.5:5});
  }
  input.approval={approved:true,reviewId:"synthetic-review",reviewerId:"synthetic-agent",
    reviewedAt:"2026-01-01T00:00:00Z",evidenceDigest:hash("synthetic-source-and-approval"),
    allocationPolicy:"approved-equal-within-official-groups",requestDigest:p2AllocationRequestDigest(input)};
  let backup;const sqls=[],options={failAudit:false};
  const client={release(){},async query(sql,v=[]){
    sqls.push(sql);
    if(sql==="BEGIN"){backup=structuredClone(state);return {rows:[],rowCount:0};}
    if(sql==="ROLLBACK"){state=backup;return {rows:[],rowCount:0};}
    if(sql==="COMMIT")return {rows:[],rowCount:0};
    if(sql.includes("pg_advisory"))return {rows:[],rowCount:1};
    if(sql.includes("FROM problems p JOIN problem_versions v")){
      const row=state.versions[v[2]];
      return {rowCount:row?1:0,rows:row?[{...state.current[v[1]],...row}]:[]};
    }
    if(sql.startsWith("SELECT * FROM problem_versions")){
      const row=state.versions[v[0]];return {rowCount:row?1:0,rows:row?[row]:[]};
    }
    if(sql.includes("FROM problem_source_map"))return {rowCount:0,rows:[]};
    if(sql.includes("FROM private_grading_keys")&&sql.includes("active_for_grading=true")){
      const rows=Object.entries(state.keys[v[1]]).filter(([,r])=>r.active_for_grading)
        .map(([key_version])=>({key_version,encryption_key_id:encryptionKeyId}));
      return {rowCount:rows.length,rows};
    }
    if(sql.includes("FROM private_grading_keys")){
      const row=state.keys[v[1]][v[2]];return {rowCount:row?1:0,rows:row?[row]:[]};
    }
    if(sql.includes("INSERT INTO problem_versions")){
      state.versions[v[0]]={version_id:v[0],subject_id:"CIVIL",stable_key:v[1],
        source_document_id:v[2],source_revision_id:v[3],source_version:v[4],stage:"P2",
        unit_id:v[5],source_order:v[6],prompt_text:v[7],max_points:v[8],prompt_digest:v[9],
        answer_digest:v[10],explanation_digest:v[11],grading_key_version:v[12],selection_metadata:JSON.parse(v[13])};
    }else if(sql.includes("INSERT INTO private_grading_keys")){
      state.keys[v[0]][v[1]]={encrypted_payload:v[3],payload_digest:v[4],verification_state:"verified",active_for_grading:false};
    }else if(sql.includes("UPDATE private_grading_keys")){
      state.keys[v[0]][v[1]].active_for_grading=sql.includes("SET active_for_grading=true");
    }else if(sql.includes("UPDATE problems")){
      state.current[v[4]]={current_problem_version_id:v[0],current_source_version:v[1],
        current_maximum:v[2],current_metadata:JSON.parse(v[3])};
    }else if(sql.includes("INSERT INTO audit_events")){
      if(options.failAudit)throw Error("synthetic audit rollback");state.audits++;
    }else throw Error("unexpected synthetic query");
    return {rowCount:1,rows:[]};
  }};
  return {input,pool:{connect:async()=>client},encryptionKey,encryptionKeyId,sqls,options,
    state:()=>state};
}
const opts=s=>({encryptionKey:s.encryptionKey,encryptionKeyId:s.encryptionKeyId});
test("allocation defaults to dry-run, validates all nine and changes no records",async()=>{
  const s=setup();const before=structuredClone(s.state());
  const r=await publishP2ScoreAllocation(s.pool,s.input,opts(s));
  assert.equal(r.dryRun,true);assert.equal(r.count,9);assert.equal(r.learningTotal,50);
  assert.deepEqual(structuredClone(s.state()),before);
  assert.equal(s.sqls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)),false);
});
test("atomic append preserves old snapshots/ciphertext and identical retry has no writes",async()=>{
  const s=setup();const old=structuredClone(s.state());
  const r=await publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false});
  assert.equal(r.inserted,9);assert.equal(Object.keys(s.state().versions).length,18);
  assert.equal(s.state().audits,1);
  for(const x of s.input.items){
    assert.deepEqual(s.state().versions[x.expectedProblemVersionId],old.versions[x.expectedProblemVersionId]);
    assert.deepEqual(Buffer.from(s.state().keys[x.stableKey].v1.encrypted_payload),Buffer.from(old.keys[x.stableKey].v1.encrypted_payload));
    assert.equal(Object.values(s.state().keys[x.stableKey]).filter(k=>k.active_for_grading).length,1);
  }
  s.sqls.length=0;
  assert.equal((await publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false})).replayed,true);
  assert.equal(s.sqls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)),false);
});
test("late audit failure rolls back every one of nine versions and key activations",async()=>{
  const s=setup();s.options.failAudit=true;
  await assert.rejects(publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false}),/audit rollback/);
  // Buffer serialized representation differs after structuredClone; compare bytes separately.
  assert.equal(Object.keys(s.state().versions).length,9);assert.equal(s.state().audits,0);
  for(const x of s.input.items){assert.equal(s.state().current[x.stableKey].current_problem_version_id,x.expectedProblemVersionId);
    assert.deepEqual(Object.keys(s.state().keys[x.stableKey]),["v1"]);assert.equal(s.state().keys[x.stableKey].v1.active_for_grading,true);}
});
test("changed distribution, missing item, stale binding and wrong decryption key fail closed",async()=>{
  for(const mutation of [
    s=>{s.input.items[0].allocatedLearningMaximum=4;},
    s=>{s.input.items.pop();},
    s=>{s.state().versions["old-9"].prompt_digest=hash("changed");},
    s=>{s.encryptionKey=crypto.randomBytes(32);},
  ]){
    const s=setup();mutation(s);s.input.approval.requestDigest=p2AllocationRequestDigest(s.input);
    await assert.rejects(publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false}));
    assert.equal(s.sqls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)),false);
  }
});

test("existing source-bound approvals are never rewritten by score-only publication",async()=>{
  for(const field of ["fixedCriteriaApproval","scoreBasisApproval"]){
    const s=setup({[field]:{reviewId:"previous-approval"}});
    await assert.rejects(publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false}),/separate review/);
    assert.equal(s.sqls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)),false);
  }
});

test("current metadata or source version drift cannot be overwritten from the old snapshot",async()=>{
  for(const field of ["current_metadata","current_source_version"]){
    const s=setup(),key=s.input.items[0].stableKey;
    s.state().current[key][field]=field==="current_metadata"?{newMetadata:"preserve"}:"external-source-change";
    await assert.rejects(publishP2ScoreAllocation(s.pool,s.input,{...opts(s),dryRun:false}),/binding mismatch/);
    assert.equal(s.sqls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)),false);
  }
});
