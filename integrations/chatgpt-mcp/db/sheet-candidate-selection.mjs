// Pure reproduction of the independent test Sheet's PB1F/P2F candidate rules.
// The caller supplies a complete, versioned snapshot of the source rows.
const MODULUS = 2147483647n;
const MULTIPLIER = 1103515245n;

function required(value, name) {
  if (value === null || value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function positiveInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
  return value;
}

function seedValue(seed) {
  return positiveInteger(seed, "seed", Number(MODULUS - 1n));
}

function rank(rowNumber, seed) {
  return Number((BigInt(rowNumber) * MULTIPLIER + BigInt(seed)) % MODULUS);
}

function compareByPriorityAndRank(a, b, seed, rowField) {
  return a.priority - b.priority || rank(a[rowField], seed) - rank(b[rowField], seed)
    || a[rowField] - b[rowField];
}

function assertStableKey(row, name) {
  required(row?.stableKey, `${name}.stableKey`);
  if (typeof row.stableKey !== "string") throw new Error(`invalid ${name}.stableKey`);
}

function assertP1Row(row) {
  assertStableKey(row, "P1 row");
  positiveInteger(row.sourceRow, "P1 sourceRow", 20004);
  positiveInteger(row.priority, "P1 priority", 1000000);
  for (const key of ["stage", "status", "excludeFlag", "answerKeyStatus", "category", "title"]) {
    required(row[key], `P1 ${key}`);
  }
}

function assertP2Group(group) {
  required(group?.groupKey, "P2 groupKey");
  positiveInteger(group.groupRow, "P2 groupRow", 516);
  positiveInteger(group.priority, "P2 group priority", 1000000);
  if (typeof group.weak !== "boolean") throw new Error("missing P2 group weak flag");
  if (typeof group.searchText !== "string") throw new Error("missing P2 group searchText");
}

function assertP2Question(question) {
  assertStableKey(question, "P2 question");
  for (const key of ["stage", "status", "answerKeyStatus", "masteryStatus"]) {
    required(question[key], `P2 ${key}`);
  }
  if (!/\-소문항[0-9]+$/.test(question.stableKey)) throw new Error("invalid P2 subquestion key");
}

export function selectP1SheetCandidates({ baseSeed, scopes, rows }) {
  seedValue(baseSeed);
  if (!Array.isArray(scopes) || !scopes.length || !Array.isArray(rows)) throw new Error("missing P1 snapshot");
  rows.forEach(assertP1Row);
  if (new Set(rows.map((row) => row.sourceRow)).size !== rows.length
      || new Set(rows.map((row) => row.stableKey)).size !== rows.length) {
    throw new Error("duplicate P1 source row or stable key");
  }
  const active = scopes.filter((scope) => scope.enabled === true && scope.count > 0);
  if (!active.length) throw new Error("no active P1 scopes");
  if (active.reduce((sum, scope) => sum + scope.count, 0) > 40) throw new Error("P1 maximum 40 exceeded");
  const seen = new Set();
  const picks = [];
  active.forEach((scope, index) => {
    required(scope.area, "P1 scope area");
    required(scope.regex, "P1 scope regex");
    positiveInteger(scope.count, "P1 scope count", 40);
    const seed = ((baseSeed + index * 104729) % 2147483646) + 1;
    let expression;
    try { expression = new RegExp(scope.regex); } catch { throw new Error("invalid P1 scope regex"); }
    const candidates = rows.filter((row) => row.stage === "1차 OX" && row.status === "활성"
      && row.excludeFlag === "아니오" && row.answerKeyStatus === "있음"
      && expression.test(`${row.category} ${row.title}`))
      .sort((a, b) => compareByPriorityAndRank(a, b, seed, "sourceRow"))
      .slice(0, 120);
    if (candidates.length < scope.count) throw new Error(`P1 insufficient candidates: ${scope.area}`);
    for (const row of candidates.slice(0, scope.count)) {
      if (seen.has(row.stableKey)) throw new Error(`P1 duplicate stable key: ${row.stableKey}`);
      seen.add(row.stableKey);
      picks.push({ area: scope.area, stableKey: row.stableKey });
    }
  });
  return picks;
}

export function selectP2SheetCandidates({ seed, mode = "전범위", keyword = "", caseCount = 1,
  groups, questions }) {
  seedValue(seed);
  positiveInteger(caseCount, "P2 caseCount", 20);
  if (!["전범위", "범위지정", "취약"].includes(mode)) throw new Error("invalid P2 mode");
  if (mode === "범위지정" && !keyword) throw new Error("P2 range requires keyword");
  if (!Array.isArray(groups) || !Array.isArray(questions)) throw new Error("missing P2 snapshot");
  groups.forEach(assertP2Group);
  questions.forEach(assertP2Question);
  if (new Set(groups.map((group) => group.groupRow)).size !== groups.length
      || new Set(groups.map((group) => group.groupKey)).size !== groups.length
      || new Set(questions.map((question) => question.stableKey)).size !== questions.length) {
    throw new Error("duplicate P2 source row or stable key");
  }
  const candidates = groups.filter((group) => mode === "취약" ? group.weak
    : mode === "범위지정" ? group.searchText.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())
      : true)
    .sort((a, b) => compareByPriorityAndRank(a, b, seed, "groupRow"))
    .slice(0, 120);
  if (candidates.length < caseCount) throw new Error("P2 insufficient case groups");
  const selected = candidates.slice(0, caseCount);
  const selectedSet = new Set(selected.map((group) => group.groupKey));
  const expanded = questions.filter((question) => question.stage === "2차 서술형"
    && question.status === "활성" && question.answerKeyStatus === "있음"
    && question.masteryStatus !== "졸업"
    && selectedSet.has(question.stableKey.replace(/-소문항[0-9]+$/, "")));
  if (!expanded.length || expanded.length > 100) throw new Error("P2 invalid expansion size");
  const byGroup = new Map(selected.map((group) => [group.groupKey, []]));
  for (const question of expanded) byGroup.get(question.stableKey.replace(/-소문항[0-9]+$/, ""))
    .push(question.stableKey);
  for (const keys of byGroup.values()) {
    if (!keys.length) throw new Error("P2 selected group has no eligible subquestions");
    keys.sort();
  }
  return selected.map((group) => ({ groupKey: group.groupKey,
    stableKeys: byGroup.get(group.groupKey) }));
}
