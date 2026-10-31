import assert from "node:assert/strict";
import test from "node:test";
import { createP2CriteriaManifest } from "../db/p2-fixed-criteria.mjs";
import { createP2EvaluationCatalog, bindP2ElementEvaluations } from "../db/p2-element-binding.mjs";
import { buildP2SemanticAudit } from "../db/p2-semantic-evaluation.mjs";
const source={modelAnswer:"Synthetic rule. Synthetic conclusion.",rubric:"Synthetic rubric.",originalAnswer:"Synthetic conclusion.",maxPoints:10};
const manifest=createP2CriteriaManifest([
  {category:"LAW",criterion:"rule",modelExcerpt:"Synthetic rule."},
  {category:"CONCLUSION",criterion:"conclusion",modelExcerpt:"Synthetic conclusion."},
],source);
function result(){const catalog=createP2EvaluationCatalog(manifest,source);return{
 criteriaDigest:catalog.criteriaDigest,elements:catalog.elements.map(e=>({elementId:e.elementId,
 status:e.category==="LAW"?"MISSING":"MATCH",answerExcerpt:e.category==="LAW"?"":"Synthetic conclusion.",explanation:"Synthetic reason"})),
 matchedLaw:[],missingLaw:[],misappliedLaw:[],improvement:"Add rule",decompositionRationale:"Two independent propositions",scoreRationale:"Ratio"};}
test("binds trusted official fields while retaining exact judgments and allowing order variation",()=>{
 const raw=result();raw.elements.reverse();const before=structuredClone(raw);
 const bound=bindP2ElementEvaluations(manifest,raw,source);
 assert.deepEqual(raw,before);
 assert.deepEqual(bound.elements.map(e=>({category:e.category,criterion:e.criterion,modelExcerpt:e.modelExcerpt})),manifest.requiredElements);
 assert.equal(buildP2SemanticAudit(bound,source).learningScore.displayedPoints,5);
});
test("missing, duplicate, unknown IDs, different manifest and authority overrides are rejected",()=>{
 const missing=result();missing.elements.pop();assert.throws(()=>bindP2ElementEvaluations(manifest,missing,source));
 const duplicate=result();duplicate.elements[1].elementId=duplicate.elements[0].elementId;assert.throws(()=>bindP2ElementEvaluations(manifest,duplicate,source));
 const unknown=result();unknown.elements[0].elementId="other";assert.throws(()=>bindP2ElementEvaluations(manifest,unknown,source));
 const wrong=result();wrong.criteriaDigest="other";assert.throws(()=>bindP2ElementEvaluations(manifest,wrong,source));
 const override=result();override.elements[0].modelExcerpt="forged";assert.throws(()=>bindP2ElementEvaluations(manifest,override,source));
});
test("binding cannot bypass original evidence or source provenance checks",()=>{
 const raw=result();raw.elements.find(e=>e.status==="MATCH").answerExcerpt="fabricated";
 assert.throws(()=>buildP2SemanticAudit(bindP2ElementEvaluations(manifest,raw,source),source),/answer evidence absent/);
 assert.throws(()=>bindP2ElementEvaluations(manifest,result(),{...source,modelAnswer:source.modelAnswer+" changed"}),/provenance/);
});
