const mode = { type: "string", enum: ["INTEGRATED", "CONCEPT_ONLY", "PROBLEM_ONLY"] };

export const CONCEPT_TOOLS = [
  { name: "getCivilConceptUnit", title: "민법 개념 단원 조회",
    description: "검증 상태를 포함한 1층·2층 강의, 회상 질문, A/B/C 논점과 승인된 문제 연결을 조회합니다.",
    inputSchema: { type: "object", required: ["unitId"], properties: {
      unitId: { type: "string", minLength: 1, maxLength: 100 }, mode,
    }, additionalProperties: false } },
  { name: "setCivilStudyMode", title: "민법 학습 모드 설정",
    description: "통합 과외·개념 전용·문제 전용 모드를 사용자별로 설정합니다.",
    inputSchema: { type: "object", required: ["mode"], properties: { mode }, additionalProperties: false } },
  { name: "getCivilDueReviews", title: "민법 복습 예정 조회",
    description: "실제 회상 이력과 활성 복습 규칙에 따라 현재 복습할 질문을 조회합니다.",
    inputSchema: { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }, additionalProperties: false } },
  { name: "submitCivilRecall", title: "민법 백지복습 기록",
    description: "사용자의 원답과 기억함·부분기억·재학습 평가를 변경 불가 이력으로 기록합니다.",
    inputSchema: { type: "object", required: ["requestId", "questionId", "answerText", "memoryResult"], properties: {
      requestId: { type: "string", minLength: 1, maxLength: 200 },
      questionId: { type: "string", minLength: 1, maxLength: 150 },
      answerText: { type: "string", minLength: 1, maxLength: 50000 },
      memoryResult: { type: "string", enum: ["REMEMBERED", "PARTIAL", "RELEARN"] },
      evidence: { type: "object" },
    }, additionalProperties: false } },
];

const allowed = {
  getCivilConceptUnit: ["unitId", "mode"], setCivilStudyMode: ["mode"],
  getCivilDueReviews: ["limit"], submitCivilRecall: ["requestId", "questionId", "answerText", "memoryResult", "evidence"],
};

export function validateConceptToolInput(name, input = {}) {
  if (!allowed[name]) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be an object");
  const unknown = Object.keys(input).filter((key) => !allowed[name].includes(key));
  if (unknown.length) throw new Error(`unsupported input: ${unknown.join(", ")}`);
  if (name === "getCivilConceptUnit") {
    const unitId = String(input.unitId || "").trim();
    const requestedMode = input.mode === undefined ? undefined : String(input.mode).trim();
    if (!unitId || unitId.length > 100) throw new Error("invalid unitId");
    if (requestedMode && !mode.enum.includes(requestedMode)) throw new Error("invalid mode");
    return { unitId, ...(requestedMode ? { mode: requestedMode } : {}) };
  }
  if (name === "setCivilStudyMode") {
    const requestedMode = String(input.mode || "").trim();
    if (!mode.enum.includes(requestedMode)) throw new Error("invalid mode");
    return { mode: requestedMode };
  }
  if (name === "getCivilDueReviews") {
    const limit = input.limit === undefined ? 10 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid limit");
    return { limit };
  }
  const requestId = String(input.requestId || "").trim();
  const questionId = String(input.questionId || "").trim();
  const answerText = String(input.answerText || "").trim();
  const memoryResult = String(input.memoryResult || "").trim();
  if (!requestId || requestId.length > 200 || !questionId || questionId.length > 150 ||
      !answerText || answerText.length > 50000 || !["REMEMBERED", "PARTIAL", "RELEARN"].includes(memoryResult)) {
    throw new Error("invalid recall input");
  }
  if (input.evidence !== undefined && (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence))) {
    throw new Error("invalid evidence");
  }
  return { requestId, questionId, answerText, memoryResult, evidence: input.evidence || {} };
}
