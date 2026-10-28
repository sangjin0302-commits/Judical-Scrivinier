import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { documentParagraphs, parseP1Document, parseP2Document } from "../db/google-docs-parser.mjs";

const paragraph = (text, startIndex) => ({
  startIndex,
  endIndex: startIndex + text.length + 1,
  paragraph: { elements: [{ textRun: { content: text + "\n" } }] },
});

test("parity maintenance route requires timing-safe ephemeral authentication", async () => {
  const source = await readFile(new URL("../app/api/maintenance/verify-google-docs-parity/route.js", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /MAINTENANCE_TOKEN/);
  assert.match(source, /verifyGoogleDocsParity/);
  assert.match(source, /error: "unauthorized"/);
});

test("tabbed Docs content flattens without losing tab-local locator", () => {
  const doc = { tabs: [{ tabProperties: { tabId: "a" }, documentTab: { body: { content: [paragraph("one", 1)] } },
    childTabs: [{ tabProperties: { tabId: "b" }, documentTab: { body: { content: [paragraph("two", 1)] } } }] }] };
  assert.deepEqual(documentParagraphs(doc).map((item) => [item.text, item.tabId]), [["one", "a"], ["two", "b"]]);
});

test("P1 parser derives approved source prefix and deduplicates identical body", () => {
  const doc = { body: { content: [
    paragraph("[민법25032] 사실인 관습의 효력 | O", 1),
    paragraph("지문: 사실인 관습은 의사를 보충한다.", 50),
    paragraph("[민법25032] 사실인 관습의 효력 | O", 100),
    paragraph("지문: 사실인 관습은 의사를 보충한다.", 150),
  ] } };
  const parsed = parseP1Document(doc, "SRC-CIV-004");
  assert.equal(parsed.occurrenceCount, 2);
  assert.equal(parsed.problems.length, 1);
  assert.equal(parsed.duplicateOccurrences, 1);
  assert.deepEqual(parsed.conflictingKeys, []);
  assert.equal(parsed.problems[0].stableKey, "SRC-CIV-004|민법25032");
});

test("P1 parser accepts compact header and prompt in one paragraph", () => {
  const doc = { body: { content: [
    paragraph("[민박2620001] 보험약관 해석 | O 지문: 약관은 객관적으로 해석한다.", 1),
  ] } };
  const parsed = parseP1Document(doc, "SRC-CIV-004B");
  assert.equal(parsed.problems[0].stableKey, "SRC-CIV-004B|민박2620001");
  assert.equal(parsed.problems[0].promptText, "약관은 객관적으로 해석한다.");
});

test("P2 parser derives year, exam, main question, subquestion and max points", () => {
  const doc = { tabs: [{ tabProperties: { tabId: "case" }, documentTab: { body: { content: [
    paragraph("2025년도 (제31회)", 1),
    paragraph("문 1", 30),
    paragraph("문제", 40),
    paragraph("[기본적 사실관계]", 50),
    paragraph("甲은 토지를 매도하였다.", 80),
    paragraph("1 결론과 근거를 설명하시오. (5점)", 120),
    paragraph("사실관계", 170),
    paragraph("매매계약 요약", 190),
    paragraph("현실답안 및 해설", 220),
    paragraph("현실답안 1 (5점)", 250),
  ] } } }] };
  const parsed = parseP2Document(doc, "SRC-CIV-005");
  assert.equal(parsed.problems.length, 1);
  assert.equal(parsed.problems[0].stableKey, "SRC-CIV-005|2025-제31회-문1-소문항1");
  assert.equal(parsed.problems[0].maxPoints, 5);
  assert.match(parsed.problems[0].promptText, /풀이 대상: 현실답안 1 \(5점\)/);
});

test("P2 parser joins a subquestion spread across paragraphs before reading points", () => {
  const doc = { body: { content: [
    paragraph("2021년도 (제27회)", 1),
    paragraph("문 2", 20),
    paragraph("문제", 30),
    paragraph("1 위 사례에서 상속인은 누구인지", 40),
    paragraph("논하시오. [20점]", 80),
    paragraph("현실답안 및 해설", 100),
    paragraph("현실답안 1 [20점]", 120),
  ] } };
  const parsed = parseP2Document(doc, "SRC-CIV-005");
  assert.equal(parsed.problems.length, 1);
  assert.equal(parsed.problems[0].maxPoints, 20);
});
