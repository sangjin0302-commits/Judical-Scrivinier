import test from "node:test";
import assert from "node:assert/strict";
import { summarizeExamProblem, getExamProgress } from "../db/exam-progress.mjs";

const p1 = { stable_key: "p1", stage: "P1" };
const p2 = { stable_key: "p2", stage: "P2" };
const a = (id, day, rate, seven) => ({ id, at: `2026-10-${String(day).padStart(2,"0")}T00:00:00.000Z`, rate, seven });

test("P1 counts verified attempts, latest pass and 7/21/60 day review", () => {
  assert.equal(summarizeExamProblem(p1, [a("a",1,0)]).reviewDueAt, "2026-10-08T00:00:00.000Z");
  assert.equal(summarizeExamProblem(p1, [a("a",1,0),a("b",2,1)]).reviewDueAt, "2026-10-23T00:00:00.000Z");
  const r = summarizeExamProblem(p1, [a("a",1,0),a("b",2,1),a("c",3,0)]);
  assert.equal(r.attempts,3);
  assert.equal(r.latestScoreRate,0);
  assert.equal(r.pass,false);
  assert.equal(r.reviewDueAt,"2026-12-02T00:00:00.000Z");
});

test("P2 diagnostic grade differs from official score, A spacing gates graduation", () => {
  const seven = [2,2,2,2,2,2,2];
  const r = summarizeExamProblem(p2, [a("a",1,.8,seven),a("b",2,.8,seven),a("c",5,.8,seven),a("d",9,.8,seven)]);
  assert.equal(r.latestDiagnosticGrade,"A");
  assert.equal(r.acceptedA,2);
  assert.equal(r.pass,true);
  assert.equal(r.graduated,false);
  assert.equal(r.mastery,"통과");
  assert.equal(summarizeExamProblem(p2,[a("a",1,.8,seven),a("b",5,.8,seven),a("c",9,.8,seven)]).graduated,true);
  assert.equal(summarizeExamProblem(p2,[a("a",1,.5,seven)]).latestDiagnosticGrade,"C");
});

test("ambiguous imported history fails closed", () => {
  const r = summarizeExamProblem(p2,[{...a("import",1,1,[2,2,2,2,2,2,2]),ambiguous:true}]);
  assert.equal(r.historyStatus,"ambiguous");
  assert.equal(r.pass,null);
  assert.equal(r.graduated,null);
});

test("service scopes all reads to owner, bounds page and withholds ambiguous imported status", async () => {
  const calls=[];
  const pool={query:async (sql,params)=>{calls.push({sql,params});
    if(sql.startsWith("SELECT stable_key")) return {rows:[p1]};
    if(sql.startsWith("WITH native AS")) return {rows:[{stage:"P1",total:1,completed:0,unattempted:0,unknown:1}]};
    if(sql.includes("UNION ALL")) return {rows:[]};
    return {rows:[{event_id:"x",stable_key:"p1",stage:"P1",created_at:"2026-10-01T00:00:00Z",payload:{score:1,maxPoints:1,validState:"유효",setId:"old"}}]};
  }};
  const r=await getExamProgress(pool,{ownerId:"owner",limit:10});
  assert.equal(r.items[0].historyStatus,"ambiguous");
  assert.equal(r.items[0].attempts,1);
  assert.equal(r.items[0].pass,null);
  assert.deepEqual(r.totals,[{stage:"P1",total:1,completed:0,unattempted:0,unknown:1}]);
  assert.equal(r.overallStatus,"partial");
  assert.ok(calls.slice(1).every(c=>c.params[0]==="owner"));
  assert.match(calls[1].sql,/length\(btrim\(oa\.answer_text\)\)>0/);
  assert.match(calls[1].sql,/e\.payload->>'validState' IN \('유효','VALID'\)/);
  assert.match(calls.find(c=>c.sql.includes("UNION ALL")).sql,
    /EXISTS \(SELECT 1 FROM original_answers oa[\s\S]*oa\.stable_key=g\.stable_key[\s\S]*length\(btrim\(oa\.answer_text\)\)>0/);
  await assert.rejects(()=>getExamProgress(pool,{ownerId:"",limit:10}),/owner/);
  await assert.rejects(()=>getExamProgress(pool,{ownerId:"owner",limit:101}),/limit/);
});
