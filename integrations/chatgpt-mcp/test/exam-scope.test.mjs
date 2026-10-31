import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HTTP MCP registers five exam tools and no retired concept or Docs maintenance tools", async () => {
  const source = await readFile(new URL("../app/mcp/route.js", import.meta.url), "utf8");
  const names = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, ["getCivilExamProgress", "issueCivilP1", "gradeCivilP1", "issueCivilP2",
    "prepareCivilP2Grade", "commitCivilP2Grade"]);
  for (const retired of ["getCivilConceptUnit", "setCivilStudyMode", "getCivilDueReviews",
    "submitCivilRecall", "recordCivilStudyActivity", "importCivilConceptQuestionTemplates",
    "verifyCivilDocsParity", "previewCivilDocsSync"]) {
    assert.ok(!source.includes(retired), retired);
  }
});

test("Docs preview remains behind a separate maintenance token route", async () => {
  const source = await readFile(new URL("../app/api/maintenance/preview-google-docs-sync/route.js", import.meta.url), "utf8");
  assert.match(source, /MAINTENANCE_TOKEN/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /if \(!authorized\(request\)\)/);
  assert.match(source, /dryRunAllGoogleDocs/);
});

test("HTTP MCP exposes database issue controls and AI learning score distinction", async () => {
  const source = await readFile(new URL("../app/mcp/route.js", import.meta.url), "utf8");
  assert.match(source, /count: z\.number\(\)\.int\(\)\.min\(1\)\.max\(40\)/);
  assert.match(source, /specificKeys: z\.array/);
  assert.match(source, /"문제지정"/);
  assert.match(source, /AI 학습평가 점수/);
  assert.match(source, /공식 채점자 점수가 아닙니다/);
  assert.match(source, /"getCivilExamProgress"/);
  assert.match(source, /annotations: readAnnotations/);
});
