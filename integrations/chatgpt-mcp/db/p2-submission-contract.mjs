// A missing subquestion is not an answer. Preserve supplied original text verbatim.
export function normalizeP2Submission(issuedKeys, answers) {
  if (!Array.isArray(issuedKeys) || issuedKeys.length < 1 ||
      !issuedKeys.every((key) => typeof key === "string" && key.trim()) ||
      new Set(issuedKeys).size !== issuedKeys.length) {
    throw new Error("invalid issued P2 keys");
  }
  if (!Array.isArray(answers) || answers.length < 1) throw new Error("at least one P2 answer required");
  const issued = new Set(issuedKeys);
  const seen = new Set();
  const submittedAnswers = answers.map((answer) => {
    if (!answer || typeof answer.key !== "string" || !issued.has(answer.key)) {
      throw new Error("answer key not in issued P2 set");
    }
    if (seen.has(answer.key)) throw new Error("duplicate P2 answer key");
    seen.add(answer.key);
    if (typeof answer.text !== "string" || !answer.text.trim()) throw new Error("empty P2 answer");
    return { key: answer.key, text: answer.text };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const unsubmittedKeys = issuedKeys.filter((key) => !seen.has(key)).sort((a, b) => a.localeCompare(b));
  return { submittedAnswers, unsubmittedKeys,
    subquestions: issuedKeys.map((key) => ({ key,
      submissionStatus: seen.has(key) ? "SUBMITTED" : "UNSUBMITTED" })) };
}
