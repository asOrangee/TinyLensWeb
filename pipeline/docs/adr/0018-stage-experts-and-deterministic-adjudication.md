---
status: accepted
date: 2026-08-25
---

# Delegate complete stage loops to stage experts and adjudicate them deterministically

> M0 ownership, its dedicated grid-sufficiency response contract, and deterministic grid
> enlargement are superseded by [ADR 0025](0025-seal-pixelized-source-grid-at-stage-m0.md).
>
> The 480-second Stage-A process-timeout duration and its reason text are superseded by
> [ADR 0028](0028-extend-stage-a-timeout-and-gpu-memory-allowance.md).

The Lens Orchestrator will own only batch-wide lens order, the fixed stage sequence, delegation, terminal-evidence verification, rerun/resume routing, and summary generation. One persistent Stage Expert per `lens × stage` will own execution, scientific review, allowed local repair, and retry for A, B, M1, M2, or M3; the existing System Inspector remains responsible for preflight and eligible M0 advances mechanically without an AI expert.

A new stateless Stage Adjudication command will reread one attempt's authoritative evidence, enforce the Hard Gate, validate the structured review and any local repair, reconstruct stage and lens retry usage from completed Stage Attempt Records, derive `accept`, `retry`, or `human_review`, and save canonical review and decision evidence. It will not select scientific findings, run the next attempt, maintain a retry counter, or decide the global stage sequence. Stage B will report structured refinement evidence without a separate `decision` field, and Stage Adjudication will map that evidence to the same three canonical decisions.

Each of A, B, M1, M2, and M3 will have its own strict expert-response schema, and the old generic Stage Reviewer and Arc Mask Expert entry points will be removed rather than retained as alternate workflows. Shared deterministic Python validation will remain the single implementation of review, repair, budget, and warning-lineage rules.

The five experts will share one operational stage-loop manual for preparation, execution, adjudication, retry, promotion, and resume mechanics, while retaining independent stage-specific scientific instructions and response schemas. This keeps common safety rules aligned without restoring a cross-stage scientific reviewer.

Stage-A's existing 480-second process timeout remains the Stage-A Expert's operational responsibility. A Stage Expert that cannot repair a blocker through the current stage's Tunable Catalog may record a non-executable development recommendation and must route the lens to Human Review; it may not modify the Packaged Pipeline during the Lens Run.

Stage Experts require unrestricted filesystem access because they inherit execution responsibility from the main Codex agent and Batch Output Directories may be outside the repository workspace. Their instructions nevertheless permit physical modeling only through `lens-agent stage` and permit result mutations only through the constrained `lens-agent` operations. Retry preparation must consume the immediately preceding attempt's canonical `review.json` and `decision: retry`; it cannot accept an unregistered external response and thereby bypass Stage Adjudication.

Every Stage Attempt Record is sealed as soon as physical execution writes `stage-execution.json`, before the modeling routine starts. A normal completion then adds `stage-result.json`; if the process dies first, the execution marker prevents rerunning the same attempt and supports a closed operational-failure decision. Re-executing or conflictingly rewriting that attempt is rejected; repeated adjudication is idempotent only when its canonical input and result are identical. Canonical decisions therefore record SHA-256 fingerprints of the attempt evidence and, when retry budget affects the decision, the reconstructed budget snapshot. Stage Adjudication also requires every unresolved upstream Handoff Warning—including passage through Stage B—to receive exactly one valid update and assigns stable references to newly accepted warnings.

A failed Hard Gate terminates the Lens Run as operational Human Review without scientific review or automatic retry. For an accepted attempt, adjudication and promotion remain separate operations: the Stage Expert invokes Attempt Promotion after the accept decision, and promotion independently rechecks the gate, manifest, decision, and candidate-chain end before atomically advancing the Accepted Stage Head.

Invalid Stage Expert responses are not retained as filesystem artifacts. The response-correction allowance is session-local, and a replacement expert starts a fresh allowance without consuming a scientific retry.

Stage Adjudication may also register a closed set of externally observed operational failures, including Stage-A timeout, execution that ended without a complete result, and exhaustion of the session-local response-correction allowance. It validates the corresponding execution marker or eligible stage result before registration. Such a report can only produce `operational_failure` Human Review and cannot manufacture acceptance or retry.

Because the Pipeline Release binds the stage artifact and decision contracts as well as the executable Packaged Pipeline, this workflow change creates a new Pipeline Release even though it does not change the physical model. Existing Lens Runs remain untouched and read-only under their recorded release; they are not resumed or migrated into the new protocol and require a Full Lens Rerun when the user wants fresh results.

This decision supersedes ADR 0004's four-command limit and supersedes the orchestration ownership portions of ADRs 0001, 0008, 0009, 0010, and 0012. Their immutable Packaged Pipeline, stage-specific scientific criteria, persistent lens-by-stage expertise, deterministic decisions, retry budgets, and attempt-local tuning rules remain in effect.
