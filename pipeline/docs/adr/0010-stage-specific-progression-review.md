---
status: accepted
superseded_in_part_by: 0011-remove-masked-stage-l
---

# Stage-specific progression review with deterministic decisions

> Stage L 的参与范围及其专属 review vocabulary 已由
> [ADR 0011](0011-remove-masked-stage-l.md) 取代；其余决策仍然有效。

> One-shot reviewer lifecycle, the Model Tuner, and Python-diff retry mechanics are superseded by
> [ADR 0012](0012-typed-attempt-local-automatic-tuning.md). Stage-specific scientific vocabulary
> and deterministic decision mapping remain in effect.

> The generic read-only Stage Reviewer and orchestrator-owned loop are superseded by
> [ADR 0018](0018-stage-experts-and-deterministic-adjudication.md); the scientific criteria remain.

> Automatic M0 advancement is superseded by [ADR 0025](0025-seal-pixelized-source-grid-at-stage-m0.md).

Non-B modeling stages use one stage-aware, read-only Stage Reviewer, while the Lens Orchestrator derives `accept`, `retry`, or `human_review` deterministically from the Hard Gate and the structured review. A–M2 use Progression Acceptance: they must provide credible upstream information without already satisfying final-product standards. M3 alone receives Final Scientific Acceptance. M0 advances automatically when its Hard Gate passes, and Stage B retains its dedicated Arc Mask Expert.

The Stage Review separates `progression_blockers` from `handoff_warnings` and may attach one stage-local Retry Repair Hypothesis. With an eligible result, no blockers means `accept`; a blocker with a valid repair hypothesis and remaining budget means `retry`; otherwise the result goes to `human_review`. Operational failures also use the existing `human_review` status but retain `operational_failure` as their reason kind. The separate `stage_decision_maker` agent is removed because it duplicated evidence review and could silently introduce stricter criteria.

This deliberately accepts model-limited residuals, physically organized clumpy sources, and non-dominant negative source pixels during progression. It blocks structural image-family failures, materially truncated downstream parameters, pathological source reconstructions, and stage-specific calibration failures. Warnings propagate downstream, retries require one allowlisted lens-local change, and accepted upstream stages are never rolled back automatically.

The trade-off is that a second LLM no longer supplies an apparent independent decision. Strict schemas, deterministic routing, stage-specific closed vocabularies, continuous diagnostics, and paired golden evaluations provide the independent control instead. The implemented contract is recorded in [Stage Review Contracts](../design/stage-review-contracts.md).
