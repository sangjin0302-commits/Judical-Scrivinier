import crypto from "node:crypto";

export const digestText = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

export function documentParagraphs(document) {
  const result = [];
  function appendContent(content, tabId) {
    for (const element of content || []) {
      const paragraph = element.paragraph;
      if (!paragraph) continue;
      const text = (paragraph.elements || []).map((item) => item.textRun?.content || "").join("")
        .replace(/\n$/, "").trim();
      if (!text) continue;
      result.push({
        text,
        tabId: tabId || "body",
        startIndex: Number(element.startIndex || 0),
        endIndex: Number(element.endIndex || 0),
      });
    }
  }
  function visitTab(tab) {
    const documentTab = tab.documentTab || {};
    appendContent(documentTab.body?.content, tab.tabProperties?.tabId);
    for (const child of tab.childTabs || []) visitTab(child);
  }
  if (Array.isArray(document.tabs) && document.tabs.length) {
    for (const tab of document.tabs) visitTab(tab);
  } else {
    appendContent(document.body?.content, "body");
  }
  return result;
}

function dedupe(items) {
  const byKey = new Map();
  let duplicateOccurrences = 0;
  const conflictingKeys = [];
  for (const item of items) {
    const prior = byKey.get(item.stableKey);
    if (!prior) byKey.set(item.stableKey, item);
    else {
      duplicateOccurrences += 1;
      if (prior.promptDigest !== item.promptDigest) conflictingKeys.push(item.stableKey);
    }
  }
  return { problems: [...byKey.values()], duplicateOccurrences, conflictingKeys };
}

export function parseP1Document(document, sourceId) {
  const paragraphs = documentParagraphs(document);
  const problems = [];
  const header = /^\[([^\]]+)\]\s*(.*?)\s*\|\s*([OX])(?:\s+지문:\s*([\s\S]+))?\s*$/;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const match = paragraphs[index].text.match(header);
    if (!match) continue;
    const prompt = match[4]?.trim() ||
      paragraphs[index + 1]?.text.match(/^지문:\s*([\s\S]+)$/)?.[1]?.trim();
    if (!prompt) throw new Error("P1 prompt missing after " + match[1]);
    problems.push({
      stableKey: sourceId + "|" + match[1].trim(),
      sourceLocator: paragraphs[index].tabId + ":" + paragraphs[index].startIndex,
      promptText: prompt,
      promptDigest: digestText(prompt),
      stage: "P1",
      maxPoints: null,
      sourceOrder: problems.length,
    });
  }
  return { ...dedupe(problems), occurrenceCount: problems.length };
}

export function normalizedPrompt(value) {
  return String(value)
    .replace(/\*\*/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function parseP2Document(document, sourceId) {
  const paragraphs = documentParagraphs(document);
  const problems = [];
  let year = null;
  let exam = null;
  let mainQuestion = null;
  let blockStart = -1;
  let activeBlock = null;
  let answerOrdinal = 0;
  const answerPattern = /^현실답안\s*[1-9]\d?(?:[-\s].*?)?(\d+(?:\.\d+)?)점(?:의\s*(\d+)\/(\d+))?/;
  function pushTarget(heading, paragraph) {
    const match = heading.match(answerPattern);
    if (!match || !activeBlock) return;
    answerOrdinal += 1;
    const basePoints = Number(match[1]);
    const points = match[2] ? basePoints * Number(match[2]) / Number(match[3]) : basePoints;
    const promptText = activeBlock + "\n\n▶ 풀이 대상: " + heading;
    const stableKey = sourceId + "|" + year + "-제" + exam + "회-문" + mainQuestion + "-소문항" + answerOrdinal;
    problems.push({
      stableKey,
      sourceLocator: paragraph.tabId + ":" + paragraph.startIndex,
      promptText,
      promptDigest: digestText(promptText),
      normalizedPromptDigest: digestText(normalizedPrompt(promptText)),
      stage: "P2",
      maxPoints: points,
      sourceOrder: problems.length,
    });
  }
  for (let index = 0; index < paragraphs.length; index += 1) {
    const text = paragraphs[index].text;
    const yearMatch = text.match(/^(\d{4})년도\s*\(제(\d+)회\)$/);
    if (yearMatch) {
      year = Number(yearMatch[1]);
      exam = Number(yearMatch[2]);
      mainQuestion = null;
      blockStart = -1;
      activeBlock = null;
      answerOrdinal = 0;
      continue;
    }
    const mainMatch = text.match(/^문\s*(\d+)$/);
    if (mainMatch && year) {
      mainQuestion = Number(mainMatch[1]);
      blockStart = -1;
      activeBlock = null;
      answerOrdinal = 0;
      continue;
    }
    if (text === "문제" && year && mainQuestion) {
      blockStart = index + 1;
      continue;
    }
    if (text === "현실답안 및 해설" && blockStart >= 0) {
      const block = paragraphs.slice(blockStart, index).map((item) => item.text);
      activeBlock = block.join("\n");
      for (let offset = 0; offset < block.length; offset += 1) {
        pushTarget(block[offset], paragraphs[blockStart + offset]);
      }
      blockStart = -1;
      continue;
    }
    pushTarget(text, paragraphs[index]);
  }
  return { ...dedupe(problems), occurrenceCount: problems.length };
}
