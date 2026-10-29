import assert from "node:assert/strict";
import test from "node:test";

import { dryRunGoogleDocsCandidates, fetchGoogleDocsSnapshotReadOnly,
  snapshotFromGoogleDoc } from "../db/google-docs-snapshot.mjs";

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
});

test("dry-run reports metadata-only baseline churn separately from changed prompt", () => {
  const snapshot = snapshotFromGoogleDoc(document(), "SRC-CIV-004");
  const samePrompt = [{ ...snapshot.problems[0], sourceVersion: "sheets-baseline",
    currentVersionId: "v1" }];
  const unchangedBody = dryRunGoogleDocsCandidates(snapshot, samePrompt);
  assert.equal(unchangedBody.readOnly, true);
  assert.equal(unchangedBody.counts.MODIFIED, 1);
  assert.equal(unchangedBody.metadataOnlyModified, 1);
  assert.equal(unchangedBody.promptModified, 0);
  const changedBody = dryRunGoogleDocsCandidates(snapshot, [{ ...samePrompt[0],
    promptDigest: "a".repeat(64) }]);
  assert.equal(changedBody.promptModified, 1);
});

test("snapshot rejects unexpected source and conflicting duplicate key", () => {
  assert.throws(() => snapshotFromGoogleDoc(document(), "SRC-CIV-999"), /unapproved/);
  const conflicting = document();
  conflicting.tabs[0].documentTab.body.content.push(paragraph("[민법25032] 관습 | O 지문: 다른 지문.", 80));
  assert.throws(() => snapshotFromGoogleDoc(conflicting, "SRC-CIV-004"), /conflicting duplicate/);
});
