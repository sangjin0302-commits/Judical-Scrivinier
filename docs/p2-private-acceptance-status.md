# P2 private acceptance status (independent test environment)

No original answer, model answer, rubric, grading key, user identifier, or private text is stored here.

- Read-only Railway audit: one submitted `PREPARED` P2 item. It is a literal abstention. Its snapshotted official model answer and rubric decrypt with the configured current key; abstention must receive zero of its official maximum. No grade was committed and the original remains unchanged.
- Existing connected ChatGPT app replayed the same prepared submission twice. The official model answer, rubric and maximum were identical on both reads. This is evidence for the existing app connection, not the new PR #5 Preview schema.
- Read-only committed history: 24 P2 grade rows have nonempty originals and are non-abstentions. One row has a verified official grading source in the current encryption generation. The other 23 cannot be re-evaluated with the unavailable prior generation; preserve them.
- Internal review of the available official source identified six nonduplicated required meaning elements. A no-answer submission misses all six. Source-derived manual expected-score vectors for complete, equivalent wording, partial, conclusion-only, wrong application, contrary rule, abstention and omission were stable on repetition. These vectors are a mechanical and human review aid; they do **not** establish production AI semantic classification reliability.
- The PR #5 `P2_GRADE_COMMIT_ENABLED` gate stays closed. Acceptance still requires repeated AI classifications of non-abstention actual or appropriately controlled answers against the private official source, with evidence and no synthetic learner records. Do not infer legal correctness from shape or arithmetic tests alone.

Audit entrypoint: `node db/verify-p2-prepared-readonly.mjs` using the existing independent test Railway PostgreSQL service environment. Output is counts only. It runs `BEGIN READ ONLY` and never writes.
