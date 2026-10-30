# Fixed P2 criteria experiment boundary

The current semantic audit accepts a caller-supplied decomposition. The same official source and answer can receive different scores if the caller omits or adds required elements. Source snapshots and post-commit idempotency do not fix this first-evaluation denominator.

`db/p2-fixed-criteria.mjs` supplies a private experiment helper. Create one manifest from the official model/rubric before evaluating candidate answers; retain it for every repeated evaluation. Validate each evaluation against that same manifest, then run the existing semantic audit. The manifest binds the complete criterion/category/evidence set and count to the normalized official source digest. Reordering is accepted; omissions, additions, duplicates, changed categories/evidence, or changed sources are rejected. Status judgments may vary and must be measured separately.

This helper neither approves criteria nor proves semantic completeness or correctness. A manifest and its digest must be retained by the trusted experiment runner; accepting a fresh caller-supplied manifest on every attempt defeats the check. Source digests identify content, not an authenticated grading-key version. Private manifests contain excerpts and must not be committed or printed.

**Not integrated with the runtime commit path.** This patch does not claim that live grading now enforces a fixed denominator. Keep `P2_GRADE_COMMIT_ENABLED=false` until semantic acceptance and the approved criterion supply path are complete.

Runtime integration requires a reviewed decomposition bound to the existing immutable grading-key/problem-version snapshot, an approved new key-version publication procedure, prepare returning that fixed criterion set after original submission, and commit loading the trusted set server-side. Existing keys and grades must remain untouched. Missing approved criteria should fail closed only once this supply path and compatibility handling are implemented. No migration, automatic criterion approval, key publication, or production change is performed here.
