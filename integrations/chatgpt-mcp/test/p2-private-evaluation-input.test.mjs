import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildPrivateP2EvaluationInput } from "../db/p2-private-evaluation-input.mjs";

const source={questionText:"Synthetic facts. Is the stated conclusion correct?",
  modelAnswer:"Synthetic official conclusion and reason.",rubric:"Synthetic requirements.",
  originalAnswer:"Yes, but my reason differs.",maxPoints:15,submissionStatus:"SUBMITTED"};
const expectedPromptDigest=createHash("sha256").update(source.questionText).digest("hex");
test("model input contains exact issued facts/question to interpret short answers",()=>{
  const result=buildPrivateP2EvaluationInput(source,{expectedPromptDigest});
  assert.equal(result.questionText,source.questionText);
  assert.equal(result.originalAnswer,source.originalAnswer);
  assert.equal(result.sourceContext.promptDigest,expectedPromptDigest);
  assert.equal(JSON.parse(JSON.stringify(result)).questionText,source.questionText);
});
test("missing context, wrong snapshot and absent provenance fail closed",()=>{
  assert.throws(()=>buildPrivateP2EvaluationInput({...source,questionText:""},{expectedPromptDigest}),/questionText/);
  assert.throws(()=>buildPrivateP2EvaluationInput(source),/provenance/);
  assert.throws(()=>buildPrivateP2EvaluationInput({...source,questionText:source.questionText+" changed"},{expectedPromptDigest}),/digest/);
});
test("original, official answer, rubric and official maximum remain mandatory",()=>{
  for(const field of ["originalAnswer","modelAnswer","rubric"]){
    assert.throws(()=>buildPrivateP2EvaluationInput({...source,[field]:""},{sourceVersion:"v1"}));
  }
  assert.throws(()=>buildPrivateP2EvaluationInput({...source,maxPoints:0},{sourceVersion:"v1"}));
  assert.throws(()=>buildPrivateP2EvaluationInput({...source,submissionStatus:"UNSUBMITTED"},{sourceVersion:"v1"}));
});
