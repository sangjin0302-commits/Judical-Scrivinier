import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyApprovedSyncCandidate,
  classifyDocumentSnapshot,
  fetchGoogleDocReadOnly,
  normalizeDocumentSnapshot,
  sha256,
} from "../db/google-docs-sync.mjs";
import { createPostgresExecutor } from "../db/postgres-adapter.mjs";

const problem = (overrides = {}) => ({
  stableKey: "SRC-CIV-001",
  sourceLocator: "heading-1",
  sourceVersion: "doc-r2:item-1",
  sourceOrder: 1,
  stage: "P1",
  unitId: null,
  promptText: "계약은 성립하였다. O/X",
  maxPoints: null,
  answerDigest: "a".repeat(64),
  explanationDigest: "b".repeat(64),
  gradingKeyVersion: "criteria-r2",
  selectionMetadata: { issueClass: "A" },
  ...overrides,
});

test("snapshot validation keeps grading content out and requires paired key generation", () => {
  const snapshot = normalizeDocumentSnapshot({
    documentId: "doc-1", title: "민법", revisionId: "r2", parserVersion: "parser-1",
    contentDigest: "c".repeat(64), problems: [problem()],
  });
  assert.equal(snapshot.problems[0].answerDigest, "a".repeat(64));
  assert.equal(Object.hasOwn(snapshot.problems[0], "answerText"), false);
  assert.throws(() => normalizeDocumentSnapshot({
    documentId: "doc-1", title: "민법", revisionId: "r2", parserVersion: "parser-1",
    contentDigest: "c".repeat(64), problems: [problem({ gradingKeyVersion: null })],
  }), /supplied together/);
  assert.throws(() => normalizeDocumentSnapshot({
    documentId: "doc-1", title: "민법", revisionId: "r2", parserVersion: "parser-1",
    contentDigest: "not-a-digest", problems: [problem()],
  }), /SHA-256 digest/);
  assert.throws(() => normalizeDocumentSnapshot({
    documentId: "doc-1", sourceId: "SRC-CIV-OTHER", title: "민법", revisionId: "r2",
    parserVersion: "parser-1", contentDigest: "c".repeat(64), problems: [problem()],
  }), /sourceId and stable keys/);
});

test("detector separates new, modified, unchanged, duplicate, and deletion candidate", () => {
  const current = [
    {
      ...problem({ stableKey: "UNCHANGED", sourceVersion: "same-v1", promptText: "same" }),
      promptDigest: sha256("same"),
      currentVersionId: "v-unchanged",
    },
    {
      ...problem({ stableKey: "MODIFIED", sourceVersion: "old-v1", promptText: "old" }),
      promptDigest: sha256("old"),
      currentVersionId: "v-modified",
    },
    {
      ...problem({ stableKey: "REMOVED", sourceVersion: "old-v1", promptText: "removed" }),
      promptDigest: sha256("removed"),
      currentVersionId: "v-removed",
    },
  ];
  const incoming = [
    problem({ stableKey: "UNCHANGED", sourceVersion: "same-v1", promptText: "same" }),
    problem({ stableKey: "MODIFIED", sourceVersion: "new-v2", promptText: "new" }),
    problem({ stableKey: "NEW", sourceVersion: "new-v1", promptText: "brand new" }),
    problem({ stableKey: "DUP", sourceLocator: "dup-1" }),
    problem({ stableKey: "DUP", sourceLocator: "dup-2" }),
  ];
  const candidates = classifyDocumentSnapshot(incoming, current);
  const byKind = candidates.reduce((groups, item) => {
    (groups[item.kind] ||= []).push(item);
    return groups;
  }, {});
  assert.equal(byKind.NEW.length, 1);
  assert.equal(byKind.MODIFIED.length, 1);
  assert.equal(byKind.UNCHANGED.length, 1);
  assert.equal(byKind.DUPLICATE.length, 1);
  assert.equal(byKind.DELETE_CANDIDATE.length, 1);
  assert.equal(byKind.DUPLICATE[0].stableKey, null);
  assert.deepEqual(byKind.DUPLICATE[0].payload.sourceLocators, ["dup-1", "dup-2"]);
  assert.equal(byKind.MODIFIED[0].payload.baseVersionId, "v-modified");
});

test("stale approved candidate cannot replace a newer problem version", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM sync_candidates c")) return { rowCount: 1, rows: [{
        state: "APPROVED", candidate_kind: "MODIFIED", stable_key: "K1",
        candidate_payload: { baseVersionId: "old-version" },
      }] };
      if (sql.includes("FROM problems") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ current_problem_version_id: "new-version" }] };
      }
      throw new Error("unexpected query");
    },
    release() {},
  };
  await assert.rejects(() => applyApprovedSyncCandidate({ connect: async () => client }, {
    candidateId: "candidate-1", actorId: "maintainer",
  }), /stale sync candidate rejected/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.some((sql) => sql.includes("UPDATE problems")), false);
});

test("rejected candidate cannot be applied even if an approval row exists", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM sync_candidates c")) return { rowCount: 1, rows: [{
        state: "REJECTED", candidate_kind: "MODIFIED", stable_key: "K1",
        candidate_payload: { baseVersionId: "v1" },
      }] };
      throw new Error("unexpected query");
    },
    release() {},
  };
  await assert.rejects(() => applyApprovedSyncCandidate({ connect: async () => client }, {
    candidateId: "candidate-rejected", actorId: "maintainer",
  }), /candidate approval state required/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.some((sql) => sql.includes("UPDATE problems")), false);
});

test("answer-only change is independently marked for grading approval", () => {
  const current = [{
    ...problem(),
    promptDigest: sha256("계약은 성립하였다. O/X"),
    currentVersionId: "v1",
  }];
  const [candidate] = classifyDocumentSnapshot([
    problem({ answerDigest: "d".repeat(64), sourceVersion: "doc-r3:item-1" }),
  ], current);
  assert.equal(candidate.kind, "MODIFIED");
  assert.equal(candidate.answerChanged, true);
  assert.equal(candidate.explanationChanged, false);
});

test("stable key already owned by another source document is a blocked duplicate", () => {
  const current = [{
    ...problem(), promptDigest: sha256("계약은 성립하였다. O/X"), currentVersionId: "v1",
    mappedDocumentId: "doc-other",
  }];
  const [candidate] = classifyDocumentSnapshot([problem()], current, "doc-current");
  assert.equal(candidate.kind, "DUPLICATE");
  assert.equal(candidate.stableKey, null);
  assert.equal(candidate.payload.conflictDocumentId, "doc-other");
});

test("Google Docs fetcher makes GET-only request and never places token in URL", async () => {
  const calls = [];
  const result = await fetchGoogleDocReadOnly({
    documentId: "doc-1",
    accessToken: "secret-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { documentId: "doc-1", revisionId: "r1" }; } };
    },
  });
  assert.equal(result.revisionId, "r1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.includes("secret-token"), false);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
});

test("migration enforces immutable versions, read-only sources, approval split, and issue snapshots", async () => {
  const sql = await readFile(new URL("../db/migrations/0004_google_docs_sync.sql", import.meta.url), "utf8");
  assert.match(sql, /CHECK \(read_only\)/);
  assert.match(sql, /problem_versions_append_only/);
  assert.match(sql, /document_sync_approval_type AS ENUM \('CONTENT', 'GRADING'\)/);
  assert.match(sql, /issue_set_items_snapshot_problem_version/);
  assert.match(sql, /Pre-Docs PostgreSQL baseline/);
  assert.match(sql, /UPDATE issue_set_items i[\s\S]*SET problem_version_id/);
  assert.match(sql, /ALTER COLUMN problem_version_id SET NOT NULL/);
  assert.match(sql, /issue_set_items_version_identity_fk/);
  assert.match(sql, /DELETE_CANDIDATE/);
});

test("issued sets read immutable problem version with legacy fallback in one query", async () => {
  let snapshotJoinSeen = false;
  const client = {
    async query(sql) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM issue_sets") && sql.includes("request_id")) {
        return { rowCount: 1, rows: [{ set_id: "P1-old", request_digest: sha256({
          requestId: "replay-1", count: 10, mode: "전범위", keyword: "",
        }) }] };
      }
      if (sql.includes("FROM issue_set_items")) {
        snapshotJoinSeen = sql.includes("LEFT JOIN problem_versions") && sql.includes("COALESCE(v.prompt_text,p.prompt_text)");
        return { rowCount: 1, rows: [{ position: 1, stable_key: "K1", prompt_text: "snapshotted prompt",
          max_points: null, source_version: "v1", selection_metadata: {} }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const execute = createPostgresExecutor({
    pool: { connect: async () => client },
    env: { GRADING_ENCRYPTION_KEY_ID: "key-v3" },
  });
  const result = await execute("issueCivilP1", { requestId: "replay-1", mode: "전범위" }, { ownerId: "user-1" });
  assert.equal(snapshotJoinSeen, true);
  assert.equal(result.questions[0].prompt, "snapshotted prompt");
});
