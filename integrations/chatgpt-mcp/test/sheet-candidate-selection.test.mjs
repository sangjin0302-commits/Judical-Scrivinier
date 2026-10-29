import test from "node:test";
import assert from "node:assert/strict";
import { selectP1SheetCandidates, selectP2SheetCandidates } from "../db/sheet-candidate-selection.mjs";

const p1 = (stableKey, sourceRow, category, priority = 1, overrides = {}) => ({
  stableKey, sourceRow, category, priority, title: "synthetic", stage: "1차 OX",
  status: "활성", excludeFlag: "아니오", answerKeyStatus: "있음", ...overrides,
});
const group = (groupKey, groupRow, priority = 1, overrides = {}) => ({
  groupKey, groupRow, priority, weak: false, searchText: `synthetic ${groupKey}`, ...overrides,
});
const question = (stableKey, overrides = {}) => ({
  stableKey, stage: "2차 서술형", status: "활성", answerKeyStatus: "있음",
  masteryStatus: "진행", ...overrides,
});

test("P1 applies active regex quotas before deterministic Sheet row ordering", () => {
  const result = selectP1SheetCandidates({ baseSeed: 100, scopes: [
    { area: "general", regex: "^제01장", count: 2, enabled: true },
    { area: "property", regex: "^제14장", count: 1, enabled: true },
    { area: "off", regex: "^제99장", count: 1, enabled: false },
  ], rows: [p1("g1", 5, "제01장", 2), p1("g2", 6, "제01장", 1),
    p1("g3", 7, "제01장", 1), p1("p1", 8, "제14장"),
    p1("unkeyed", 9, "제14장", 1, { answerKeyStatus: "없음" })] });
  assert.deepEqual(result.map((item) => item.stableKey), ["g2", "g3", "p1"]);
});

test("P1 fails closed on missing selection metadata, duplicate scopes, and insufficient pool", () => {
  const scopes = [{ area: "one", regex: "제01장", count: 1, enabled: true }];
  assert.throws(() => selectP1SheetCandidates({ baseSeed: 1, scopes,
    rows: [p1("x", 5, "제01장", undefined, { priority: undefined })] }), /priority/);
  assert.throws(() => selectP1SheetCandidates({ baseSeed: 1, scopes: [...scopes, scopes[0]],
    rows: [p1("x", 5, "제01장")] }), /duplicate stable key/);
  assert.throws(() => selectP1SheetCandidates({ baseSeed: 1, scopes,
    rows: [p1("x", 5, "제14장")] }), /insufficient candidates/);
  assert.throws(() => selectP1SheetCandidates({ baseSeed: 1, scopes,
    rows: [p1("x", 5, "제01장"), p1("x", 6, "제01장")] }), /duplicate P1/);
});

test("P2 selects case groups and expands all eligible subquestions", () => {
  const result = selectP2SheetCandidates({ seed: 100, caseCount: 1,
    groups: [group("case-a", 17, 1), group("case-b", 18, 2)],
    questions: [question("case-a-소문항2"), question("case-a-소문항1"),
      question("case-a-소문항3", { masteryStatus: "졸업" }), question("case-b-소문항1")] });
  assert.deepEqual(result, [{ groupKey: "case-a", stableKeys: ["case-a-소문항1", "case-a-소문항2"] }]);
});

test("P2 applies weak and range group filters, preserving case count", () => {
  const groups = [group("case-a", 17, 1, { weak: false, searchText: "총칙" }),
    group("case-b", 18, 2, { weak: true, searchText: "물권법 지상권" })];
  const questions = [question("case-a-소문항1"), question("case-b-소문항1")];
  assert.deepEqual(selectP2SheetCandidates({ seed: 1, mode: "취약", caseCount: 1,
    groups, questions }).map((item) => item.groupKey), ["case-b"]);
  assert.deepEqual(selectP2SheetCandidates({ seed: 1, mode: "범위지정", keyword: "지상권",
    caseCount: 1, groups, questions }).map((item) => item.groupKey), ["case-b"]);
});

test("P2 fails closed when selected group cannot expand or required metadata is missing", () => {
  const groups = [group("case-a", 17)];
  assert.throws(() => selectP2SheetCandidates({ seed: 1, groups,
    questions: [question("case-a-소문항1", { masteryStatus: "졸업" })] }), /invalid expansion size/);
  assert.throws(() => selectP2SheetCandidates({ seed: 1,
    groups: [group("case-a", 17, 1, { weak: undefined })], questions: [] }), /weak flag/);
  assert.throws(() => selectP2SheetCandidates({ seed: 1, mode: "범위지정",
    groups, questions: [] }), /keyword/);
  assert.throws(() => selectP2SheetCandidates({ seed: 1,
    groups: [group("case-a", 17), group("case-a", 18)], questions: [] }), /duplicate P2/);
});
