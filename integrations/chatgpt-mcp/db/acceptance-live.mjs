import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { createPostgresExecutor, createPostgresPool } from "./postgres-adapter.mjs";

const FAILED_PREPARED_SET = "P2-20261028-133103-a20116";
const TABLES = [
  "problems", "private_grading_keys", "issue_sets", "issue_set_items", "submissions",
  "original_answers", "p1_grades", "p2_grades", "learning_events",
];

const env = process.env;
const applySynthetic = env.APPLY_SYNTHETIC_ACCEPTANCE === "1";
const ownerPrefix = String(env.ACCEPTANCE_OWNER_PREFIX || "").trim();
if (applySynthetic && ownerPrefix !== "acceptance-synthetic") {
  throw new Error("writes require ACCEPTANCE_OWNER_PREFIX=acceptance-synthetic");
}
if (applySynthetic && env.ACCEPTANCE_ISOLATED_DATABASE !== "1") {
  throw new Error("synthetic writes are forbidden outside an explicitly isolated database");
}

const pool = createPostgresPool(env);

async function readonlySnapshot() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const counts = {};
    for (const table of TABLES) {
      const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0].count;
    }
    const failed = await client.query(
      `SELECT i.state,
              (SELECT count(*)::int FROM original_answers a
                JOIN submissions s USING(submission_id) WHERE s.set_id=i.set_id) AS original_answers,
              (SELECT count(*)::int FROM p2_grades g
                JOIN submissions s USING(submission_id) WHERE s.set_id=i.set_id) AS p2_grades
         FROM issue_sets i WHERE i.set_id=$1`,
      [FAILED_PREPARED_SET],
    );
    await client.query("ROLLBACK");
    return { counts, failedPreparedSet: failed.rows[0] || null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, milliseconds: Math.round((performance.now() - started) * 10) / 10 };
}

async function expectReject(operation, pattern) {
  const started = performance.now();
  try {
    await operation();
  } catch (error) {
    if (!pattern.test(String(error?.message || ""))) throw error;
    return Math.round((performance.now() - started) * 10) / 10;
  }
  throw new Error(`expected rejection: ${pattern}`);
}

function changedOx(answers) {
  const changed = [...answers];
  changed[0] = changed[0] === "O" ? "X" : "O";
  return changed;
}

function p2Evaluations(rubrics, overrides = {}) {
  return rubrics.map((rubric, index) => ({
    key: rubric.key,
    maxPoints: rubric.maxPoints,
    awardedPoints: overrides.awardedPoints ?? 0,
    scores: {
      issue: index === 0 && overrides.invalidScore ? 3 : 0,
      outline: 0,
      law: 0,
      precedent: 0,
      application: 0,
      conclusion: 0,
      expression: 0,
    },
    correction: "synthetic infrastructure acceptance",
    errorType: "synthetic-test-only",
    checkType: "synthetic-test-only",
    missingOutline: "",
    wrongLaw: "",
    applicationFix: "",
    modelDifference: "",
    nextReview: "synthetic-test-only",
  }));
}

async function assertOriginalAnswerImmutable(setId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE original_answers SET answer_text='mutation-must-fail'
          WHERE submission_id=(SELECT submission_id FROM submissions WHERE set_id=$1)`,
        [setId],
      );
      throw new Error("original answer mutation was accepted");
    } catch (error) {
      await client.query("ROLLBACK");
      if (!/append-only|original_answers|immutable|not in prerequisite state/i.test(String(error?.message || ""))) {
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function assertPreparedAfterRejectedCommit(setId, expectedAnswers) {
  const result = await pool.query(
    `SELECT s.state,
            (SELECT count(*)::int FROM original_answers a WHERE a.submission_id=s.submission_id) AS answers,
            (SELECT count(*)::int FROM p2_grades g WHERE g.submission_id=s.submission_id) AS grades
       FROM submissions s WHERE s.set_id=$1`,
    [setId],
  );
  const row = result.rows[0];
  if (!row || row.state !== "PREPARED" || row.answers !== expectedAnswers || row.grades !== 0) {
    throw new Error("rejected P2 commit left partial state");
  }
}

async function runSyntheticAcceptance() {
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const ownerId = `${ownerPrefix}:${runId}`;
  const otherOwnerId = `${ownerPrefix}:other:${runId}`;
  const executor = createPostgresExecutor({ pool, env });
  const timings = {};

  const p1RequestId = `accept-p1-${runId}`;
  const p1Issue = await timed(() => executor("issueCivilP1", { requestId: p1RequestId }, { ownerId }));
  timings.p1Issue = p1Issue.milliseconds;
  const p1Replay = await timed(() => executor("issueCivilP1", { requestId: p1RequestId }, { ownerId }));
  timings.p1IssueReplay = p1Replay.milliseconds;
  if (!p1Replay.value.replayed || p1Replay.value.setId !== p1Issue.value.setId) {
    throw new Error("P1 issue replay mismatch");
  }
  timings.p1OwnershipReject = await expectReject(
    () => executor("gradeCivilP1", { setId: p1Issue.value.setId, answers: Array(10).fill("O") }, { ownerId: otherOwnerId }),
    /ownership denied/,
  );
  const p1Answers = Array(10).fill("O");
  const p1Grades = await timed(() => Promise.all([
    executor("gradeCivilP1", { setId: p1Issue.value.setId, answers: p1Answers }, { ownerId }),
    executor("gradeCivilP1", { setId: p1Issue.value.setId, answers: p1Answers }, { ownerId }),
  ]));
  timings.p1ConcurrentGrade = p1Grades.milliseconds;
  if (p1Grades.value.filter((result) => result.replayed).length !== 1) {
    throw new Error("P1 duplicate grade was not idempotent");
  }
  timings.p1ChangedAnswerReject = await expectReject(
    () => executor("gradeCivilP1", { setId: p1Issue.value.setId, answers: changedOx(p1Answers) }, { ownerId }),
    /changed answer payload rejected/,
  );

  const p2RequestId = `accept-p2-${runId}`;
  const p2Issue = await timed(() => executor(
    "issueCivilP2", { requestId: p2RequestId, caseCount: 1 }, { ownerId },
  ));
  timings.p2Issue = p2Issue.milliseconds;
  const p2Replay = await timed(() => executor(
    "issueCivilP2", { requestId: p2RequestId, caseCount: 1 }, { ownerId },
  ));
  timings.p2IssueReplay = p2Replay.milliseconds;
  if (!p2Replay.value.replayed || p2Replay.value.setId !== p2Issue.value.setId) {
    throw new Error("P2 issue replay mismatch");
  }
  timings.p2ChangedIssueReject = await expectReject(
    () => executor("issueCivilP2", { requestId: p2RequestId, caseCount: 1, keyword: "changed" }, { ownerId }),
    /changed issue payload rejected/,
  );
  const p2Answers = p2Issue.value.questions.map((question) => ({
    key: question.key,
    text: "synthetic infrastructure acceptance answer; not learner performance",
  }));
  timings.p2OwnershipReject = await expectReject(
    () => executor("prepareCivilP2Grade", { setId: p2Issue.value.setId, answers: p2Answers }, { ownerId: otherOwnerId }),
    /ownership denied/,
  );
  const p2Prepared = await timed(() => Promise.all([
    executor("prepareCivilP2Grade", { setId: p2Issue.value.setId, answers: p2Answers }, { ownerId }),
    executor("prepareCivilP2Grade", { setId: p2Issue.value.setId, answers: p2Answers }, { ownerId }),
  ]));
  timings.p2ConcurrentPrepare = p2Prepared.milliseconds;
  if (p2Prepared.value.filter((result) => result.replayed).length !== 1) {
    throw new Error("P2 duplicate prepare was not idempotent");
  }
  const rubrics = p2Prepared.value[0].rubrics;
  const changedP2Answers = p2Answers.map((answer, index) => ({
    ...answer,
    text: index === 0 ? `${answer.text} changed` : answer.text,
  }));
  timings.p2ChangedAnswerReject = await expectReject(
    () => executor("prepareCivilP2Grade", { setId: p2Issue.value.setId, answers: changedP2Answers }, { ownerId }),
    /changed answer payload rejected/,
  );
  const invalidEvaluations = p2Evaluations(rubrics, { invalidScore: true });
  timings.p2SevenElementReject = await expectReject(
    () => executor("commitCivilP2Grade", { setId: p2Issue.value.setId, evaluations: invalidEvaluations }, { ownerId }),
    /check constraint|violates/i,
  );
  await assertPreparedAfterRejectedCommit(p2Issue.value.setId, p2Answers.length);
  await assertOriginalAnswerImmutable(p2Issue.value.setId);
  const evaluations = p2Evaluations(rubrics);
  const p2Committed = await timed(() => Promise.all([
    executor("commitCivilP2Grade", { setId: p2Issue.value.setId, evaluations }, { ownerId }),
    executor("commitCivilP2Grade", { setId: p2Issue.value.setId, evaluations }, { ownerId }),
  ]));
  timings.p2ConcurrentCommit = p2Committed.milliseconds;
  if (p2Committed.value.filter((result) => result.replayed).length !== 1) {
    throw new Error("P2 duplicate commit was not idempotent");
  }
  const changedEvaluations = evaluations.map((evaluation, index) => ({
    ...evaluation,
    correction: index === 0 ? "changed synthetic evaluation" : evaluation.correction,
  }));
  timings.p2ChangedEvaluationReject = await expectReject(
    () => executor("commitCivilP2Grade", { setId: p2Issue.value.setId, evaluations: changedEvaluations }, { ownerId }),
    /changed evaluation payload rejected/,
  );

  return {
    ok: true,
    classification: "synthetic-infrastructure-only-not-learning-outcome",
    requestIds: { p1: p1RequestId, p2: p2RequestId },
    checks: {
      p1IssueReplay: true,
      p1Ownership: true,
      p1ConcurrentDuplicate: true,
      p1ChangedAnswerRejected: true,
      p2IssueReplay: true,
      p2ChangedIssueRejected: true,
      p2Ownership: true,
      p2ConcurrentPrepare: true,
      p2ChangedAnswerRejected: true,
      p2SevenElementConstraint: true,
      p2PartialFailureRollback: true,
      originalAnswerImmutable: true,
      p2ConcurrentCommit: true,
      p2ChangedEvaluationRejected: true,
    },
    timings,
  };
}

try {
  const before = await readonlySnapshot();
  if (!applySynthetic) {
    process.stdout.write(JSON.stringify({ ok: true, mode: "READ ONLY", snapshot: before }));
  } else {
    const acceptance = await runSyntheticAcceptance();
    const after = await readonlySnapshot();
    if (JSON.stringify(before.failedPreparedSet) !== JSON.stringify(after.failedPreparedSet)) {
      throw new Error("existing PREPARED set changed during acceptance");
    }
    process.stdout.write(JSON.stringify({
      ...acceptance,
      existingPreparedSetUnchanged: true,
      rowDeltas: Object.fromEntries(TABLES.map((table) => [table, after.counts[table] - before.counts[table]])),
    }));
  }
} finally {
  await pool.end();
}
