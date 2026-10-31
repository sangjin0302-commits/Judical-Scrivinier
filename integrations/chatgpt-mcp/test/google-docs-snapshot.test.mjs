import assert from "node:assert/strict";
import test from "node:test";

import { dryRunGoogleDocsCandidates, fetchGoogleDocsSnapshotReadOnly,
  snapshotFromGoogleDoc } from "../db/google-docs-snapshot.mjs";
import { classifyDocumentSnapshot } from "../db/google-docs-sync.mjs";
import { dryRunAllGoogleDocs } from "../db/dry-run-google-docs-sync.mjs";

const paragraph = (text, startIndex) => ({ startIndex, endIndex: startIndex + text.length + 1,
  paragraph: { elements: [{ textRun: { content: text + "\n" } }] } });

const document = () => ({ documentId: "doc-1", revisionId: "r1", title: "민법 1차",
  tabs: [{ tabProperties: { tabId: "tab-1" }, documentTab: { body: { content: [
    paragraph("[민법25032] 관습 | O", 1),
    paragraph("지문: 관습은 의사를 보충한다.", 40),
  ] } } }] });

test("live Docs snapshot keeps stable key and prompt without answer or grading material", async () => {
  const seen = [];
  const snapshot = await fetchGoogleDocsSnapshotReadOnly({ documentId: "doc-1",
    sourceId: "SRC-CIV-004", accessToken: "private-token", fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, async json() { return document(); } };
    } });
  assert.equal(seen[0].init.method, "GET");
  assert.match(seen[0].url, /includeTabsContent=true/);
  assert.equal(seen[0].url.includes("private-token"), false);
  assert.equal(snapshot.problems[0].stableKey, "SRC-CIV-004|민법25032");
  assert.match(snapshot.problems[0].sourceVersion, /^docs:[a-f0-9]{64}$/);
  assert.equal(snapshot.problems[0].answerDigest, null);
  assert.equal(snapshot.problems[0].explanationDigest, null);
  assert.equal(snapshot.problems[0].gradingKeyVersion, null);
  assert.equal(snapshot.problems[0].gradingFieldsKnown, false);
});

test("new P2 case snapshot preserves group keys and has no inferred grading key", () => {
  const caseDoc = { documentId: "doc-p2", revisionId: "revision-new", title: "민법 2차",
    body: { content: [
      paragraph("2026년도 (제32회)", 1), paragraph("문 3", 30), paragraph("문제", 40),
      paragraph("甲의 행위를 검토하시오.", 50), paragraph("현실답안 및 해설", 100),
      paragraph("현실답안 3 가 (10점)", 120), paragraph("모범답안: 비공개", 150),
      paragraph("현실답안 3 나 (15점)", 190),
    ] } };
  const snapshot = snapshotFromGoogleDoc(caseDoc, "SRC-CIV-005");
  assert.deepEqual(snapshot.problems.map((item) => item.stableKey), [
    "SRC-CIV-005|2026-제32회-문3-소문항1",
    "SRC-CIV-005|2026-제32회-문3-소문항2",
  ]);
  assert.deepEqual(snapshot.problems.map((item) => item.maxPoints), [10, 15]);
  assert.ok(snapshot.problems.every((item) => item.gradingKeyVersion === null));
  assert.ok(snapshot.problems.every((item) => !item.promptText.includes("모범답안:")));
  assert.deepEqual(dryRunGoogleDocsCandidates(snapshot, []).counts,
    { NEW: 2, MODIFIED: 0, UNCHANGED: 0, DUPLICATE: 0, DELETE_CANDIDATE: 0 });
});

test("inserting a new P1 before an old problem keeps old key and separates candidates", () => {
  const before = snapshotFromGoogleDoc(document(), "SRC-CIV-004");
  const edited = document();
  edited.revisionId = "r2";
  edited.tabs[0].documentTab.body.content.unshift(
    paragraph("[민법26001] 새 논점 | X", 1),
    paragraph("지문: 새 공식 지문.", 20),
  );
  const after = snapshotFromGoogleDoc(edited, "SRC-CIV-004");
  const prior = [{ ...before.problems[0], currentVersionId: "v-old" }];
  const candidates = classifyDocumentSnapshot(after.problems, prior, after.documentId);
  assert.equal(candidates.find((item) => item.stableKey === "SRC-CIV-004|민법26001")?.kind, "NEW");
  assert.equal(candidates.find((item) => item.stableKey === "SRC-CIV-004|민법25032")?.kind, "UNCHANGED");
  assert.equal(after.problems[1].sourceVersion === before.problems[0].sourceVersion, false);
  assert.deepEqual(dryRunGoogleDocsCandidates(after, prior).counts,
    { NEW: 1, MODIFIED: 0, UNCHANGED: 1, DUPLICATE: 0, DELETE_CANDIDATE: 0 });
});

test("question-only Docs change preserves existing grading and unit metadata", () => {
  const snapshot = snapshotFromGoogleDoc(document(), "SRC-CIV-004");
  const prior = { ...snapshot.problems[0], promptDigest: snapshot.problems[0].promptDigest,
    sourceVersion: "sheets-baseline", currentVersionId: "v1", unitId: "B1-P0001-0001",
    answerDigest: "a".repeat(64), explanationDigest: "b".repeat(64),
    gradingKeyVersion: "criteria-verified", selectionMetadata: { issueClass: "A" } };
  const result = dryRunGoogleDocsCandidates(snapshot, [prior]);
  assert.equal(result.counts.UNCHANGED, 1);
  assert.equal(result.counts.MODIFIED, 0);
  assert.equal(result.baselineMetadataOnly, 1);
  assert.equal(result.promptModified, 0);
  const [candidate] = classifyDocumentSnapshot(snapshot.problems, [prior], snapshot.documentId);
  assert.equal(candidate.answerChanged, false);
  assert.equal(candidate.explanationChanged, false);
  assert.equal(candidate.payload.gradingKeyVersion, "criteria-verified");
  assert.equal(candidate.payload.unitId, "B1-P0001-0001");
  assert.deepEqual(candidate.payload.selectionMetadata, { issueClass: "A" });
});

test("dry-run reports metadata-only baseline churn separately from changed prompt", () => {
  const snapshot = snapshotFromGoogleDoc(document(), "SRC-CIV-004");
  const samePrompt = [{ ...snapshot.problems[0], sourceVersion: "sheets-baseline",
    currentVersionId: "v1" }];
  const unchangedBody = dryRunGoogleDocsCandidates(snapshot, samePrompt);
  assert.equal(unchangedBody.readOnly, true);
  assert.equal(unchangedBody.counts.UNCHANGED, 1);
  assert.equal(unchangedBody.counts.MODIFIED, 0);
  assert.equal(unchangedBody.baselineMetadataOnly, 1);
  assert.equal(unchangedBody.promptModified, 0);
  const changedBody = dryRunGoogleDocsCandidates(snapshot, [{ ...samePrompt[0],
    promptText: "다른 법률효과", promptDigest: "a".repeat(64) }]);
  assert.equal(changedBody.promptModified, 1);
  assert.equal(changedBody.counts.MODIFIED, 1);
  const formatOnly = dryRunGoogleDocsCandidates(snapshot, [{ ...samePrompt[0],
    promptText: "관습은 **의사를** 보충한다.", promptDigest: "b".repeat(64) }]);
  assert.equal(formatOnly.counts.MODIFIED, 0);
  assert.equal(formatOnly.normalizedOnly, 1);
});

test("snapshot rejects unexpected source and conflicting duplicate key", () => {
  assert.throws(() => snapshotFromGoogleDoc(document(), "SRC-CIV-999"), /unapproved/);
  const automatic = "SRC-CIV-AUTO-" + "a".repeat(32);
  assert.throws(() => snapshotFromGoogleDoc(document(), automatic), /unapproved/);
  assert.equal(snapshotFromGoogleDoc(document(), automatic, "P1").problems[0].stableKey,
    automatic + "|민법25032");
  assert.throws(() => snapshotFromGoogleDoc(document(), automatic, "P2"), /no official problems recognized/);
  const conflicting = document();
  conflicting.tabs[0].documentTab.body.content.push(paragraph("[민법25032] 관습 | O 지문: 다른 지문.", 80));
  assert.throws(() => snapshotFromGoogleDoc(conflicting, "SRC-CIV-004"), /conflicting duplicate/);
});

test("live sync preview reads DB in one read-only transaction and emits counts only", async () => {
  const queries = [];
  class Pool {
    async connect() { return {
      query: async (sql) => {
        queries.push(sql);
        if (sql.startsWith("SELECT p.stable_key")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }, release() {},
    }; }
    async end() {}
  }
  const result = await dryRunAllGoogleDocs({
    env: { DATABASE_URL: "postgresql://test:test@localhost/test", GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh" },
    Pool, sources: [["SRC-CIV-004", "doc-1"]],
    fetchImpl: async (url, init) => {
      if (url.includes("oauth2.googleapis.com")) return { ok: true,
        async json() { return { access_token: "private-token" }; } };
      assert.equal(init.method, "GET");
      return { ok: true, async json() { return document(); } };
    },
  });
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(queries.some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql)), false);
  assert.equal(result.sources[0].counts.NEW, 1);
  assert.equal(JSON.stringify(result).includes("관습은 의사를"), false);
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});
