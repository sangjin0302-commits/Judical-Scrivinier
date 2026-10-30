# P2 model answer ratio score contract

The user-approved scoring policy is an **AI learning evaluation**, not a score awarded by an official examiner. The official model answer and existing rubric are the sole source. No external law research or invented criterion weights are required.

The default numeric result for every supported P2 subquestion is the model-answer
meaning-element ratio below. Text similarity, answer length, stylistic quality,
and the seven diagnostics must not replace this calculation. Equivalent wording
is eligible for full credit when it expresses the same required meaning.

`subquestion learning points = official subquestion maximum × (full matches + 0.5 × partial matches) / fixed required element count`

1. Save the original answer first. Fetch the corresponding protected model answer/rubric only for that submitted set. Supply the exact issued question snapshot, including common facts and the target subquestion, with the original and official source. Verify snapshot provenance. Short answers such as an affirmative reply cannot be interpreted safely without the question they answer. `buildPrivateP2EvaluationInput` requires this context for private acceptance evaluations; missing context invalidates those evaluations rather than producing learner scores.
2. Decompose the official source into nonduplicate required meaning elements (issue, rule, element, application, conclusion as present). Each element must carry an exact source excerpt and a necessity explanation. Do not divide by sentence or word count. Review the decomposition against the official source before fixing it for candidate-answer evaluation. Do not tailor the denominator to a particular learner answer or desired score.
3. Compare the original answer semantically. `MATCH` and sourced `ALTERNATIVE_ACCEPTED` = 1; `PARTIAL` = 0.5; `MISSING` and `ERROR` = 0. Exact answer excerpts anchor nonmissing classifications. Alternative reasoning needs a review reference. Pure abstention has every element `MISSING` and every seven-element diagnostic 0. For partial case submissions, `normalizeP2Submission` keeps only supplied originals and marks absent issued subquestions `UNSUBMITTED`; literal `모르겠다` remains `SUBMITTED`. Do not manufacture a text answer for an omitted subquestion. An `UNSUBMITTED` audit has no original and zero matched elements/points.
4. `calculateP2LearningScore(elements,maxPoints)` returns half-unit numerator/denominator, exact raw fraction, numeric raw points, and a display rounded to two decimal places. `buildP2SemanticAudit` includes this as `learningScore` when passed `maxPoints`; an optional submitted `awardedPoints` must equal the computed displayed points.
5. Seven diagnostic fields remain separate; they do not add to or reweight the ratio score. Preserve raw calculation, displayed score, maximum, method, source digest, evidence digests, and decomposition rationale with the immutable grading record.

## Required meaning and partial-credit boundaries

- Count the operative rule once. A precedent that merely repeats that rule is not another required element. A genuinely separate precedent proposition or a distinct application to the case facts may be required; explain why it adds independent meaning.
- A correct result and its reasoning can be separate required meanings. Wrong or absent reasoning must not automatically erase a correctly expressed conclusion. Conversely, a correct conclusion does not establish that an omitted legal rule or application was written.
- Where the official answer requires both a basic conclusion and a limitation of parties, scope, or extent, identify those meanings explicitly. Use independent elements when both carry independent meaning, or a justified compound element with an explicit partial-credit condition. Do not turn each word or incidental detail into another equally weighted element.
- `PARTIAL` requires an expressly stated, independently correct part of the required meaning without contradiction of its operative core. Mere mention of a topic or statute does not earn half credit. A genuinely indivisible proposition may have no partial-credit route.
- `ERROR` requires an expressed incompatible proposition about the same legal/factual target. `MISSING` means the required proposition is absent. An unrelated wrong conclusion is not evidence that every unstated rule was expressly misstated.
- Resolve references such as “yes” against the issued question and surrounding answer. Preserve the learner's wording; do not complete an argument they did not write.

## Fixed denominator and official points

`createP2CriteriaManifest` binds the reviewed element identities, categories,
official evidence, and official-source digest. `validateP2FixedCriteria` rejects
later additions, deletions, or substitutions. Runtime validation uses the
manifest in the encrypted grading-key snapshot, not a manifest supplied with the
learner evaluation. A manifest freezes a decomposition; it does not certify that
the initial decomposition is exhaustive, nonduplicative in meaning, or legally
correct. Semantic duplicate review remains necessary even when the criterion
labels differ.

Use the official maximum for each issued subquestion. Do not allocate equal
maximums across subquestions or infer point weights from the model answer's
length. The current calculator applies one equal-element ratio within that
subquestion. It does **not** implement official internal point partitions or
weighted elements. If an official rubric prescribes separate internal scores or
mandatory deductions that this ratio cannot represent, record the discrepancy
and require an explicit supported mapping before claiming compliance with those
rules. Never silently invent weights or say the ratio reproduces examiner marks.

## Evidence and limits

The functions validate evidence anchors, fixed identities, and arithmetic. They
**cannot prove semantic correctness** or that the required elements exhaust the
official answer. Element count is itself a substantive judgment: counting the
same omitted rule twice changes both the denominator and the learner's score.
Therefore a stable calculation or repeated identical model result alone is not
an accuracy certificate. Report decomposition review, classification agreement,
valid-evidence variation, and score spread separately.

Retain failed acceptance runs and their cause. Runs missing the issued question
are `INVALID_INPUT_CONTEXT`; runs using an invalid duplicate decomposition are
superseded after review. Neither becomes a learner score. Do not average unstable
classifications into an apparently definitive score.

Acceptance requires source-based decomposition review, repeated classifications
of submitted answers, and guarded test-DB commit/replay/ownership/rollback
evidence. A verified individual test set does not prove all P2 sources ready.
Synthetic answers must never become user learning history. Keep unrestricted
P2 commit closed until its release conditions pass; any explicitly authorized
test-set exception must retain its scope and must not bypass source, ownership,
or immutable-original checks.
