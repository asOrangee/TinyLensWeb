# Stage Review Contracts

Status: historical; superseded by [ADR 0018](../adr/0018-stage-experts-and-deterministic-adjudication.md) and, for source-grid ownership, [ADR 0025](../adr/0025-seal-pixelized-source-grid-at-stage-m0.md).

This document records the previous combined-review design. Current runs use one independent Stage
Expert for each of A, B, M0, M1, M2, and M3, with deterministic Python adjudication. Follow ADR 0018,
ADR 0025, and the active `lens-model-orchestrator` skill for current behavior.
Current blocker and warning semantics are defined exclusively in the
[Stage Review Scientific Glossary](../../.codex/skills/lens-model-orchestrator/references/stage-review-glossary.md).

This document defines the scientific review contract for the serial A → B → M0 → M1 → M2 → M3 workflow.

## Review ownership

- Stage B remains owned by the persistent Arc Mask Expert.
- M0 uses a grid-sufficiency-only persistent expert after its numerical Hard Gate passes.
- A, M0, M1, M2, and M3 each use one Persistent Stage Reviewer per `lens × stage`, retained across
  eligible retries, with a common structured output.
- The separate `stage_decision_maker` is removed.
- The Lens Orchestrator validates the review, derives the decision mechanically, and writes `decision.json`.
- An accepted upstream stage is never rolled back automatically.

## Acceptance levels

**Progression Acceptance** applies to A–M2. The result must be safe and useful as upstream information for the next stage. It may retain Model-Limited Residuals, provisional source structure, and Handoff Warnings.

**Final Scientific Acceptance** applies only to M3. It requires a credible terminal result within the simple EPL+shear workflow, but does not require every residual pixel to be white noise.

## Deterministic decision mapping

| Preconditions | Derived decision |
|---|---|
| Hard Gate fails or no valid stage evidence exists | `human_review`, `reason_kind: operational_failure` |
| Hard Gate passes and `progression_blockers` is empty | `accept` |
| Hard Gate passes, a blocker has one valid atomic Retry Repair, and budget remains | `retry` |
| Hard Gate passes, a blocker has no valid local repair, or budget is exhausted | `human_review`, `reason_kind: scientific_blocker` |

The reviewer does not return a free-form decision. The orchestrator persists the derived decision and rejects any review that violates its schema or stage contract.

## Stage Review schema

```json
{
  "stage": "a|m1|m2|m3",
  "visual_findings": ["artifact-specific finding"],
  "numerical_findings": ["metric-specific finding"],
  "progression_blockers": [
    {
      "kind": "closed_stage_specific_kind",
      "evidence": ["artifact and observation"],
      "impact": "why downstream information would be unsafe"
    }
  ],
  "handoff_warnings": [
    {
      "kind": "closed_stage_specific_kind",
      "evidence": ["artifact and observation"],
      "impact": "what downstream must monitor",
      "expected_resolution_stage": "m0|m1|m2|m3|final"
    }
  ],
  "upstream_warning_updates": [
    {
      "warning_ref": "orchestrator-assigned reference",
      "status": "resolved|persisted|worsened",
      "evidence": ["current-stage observation"]
    }
  ],
  "retry_repair": null,
  "reason": "concise synthesis"
}
```

`retry_repair` is `null` when there is no valid stage-local repair. The proposal changes exactly
one Tunable Catalog leaf and supplies an absolute value; it is not a step request or code patch.
Every finding cites concrete artifacts and numerical or visual evidence. A new phenomenon that
does not match the stage's closed blocker vocabulary may be recorded as `unclassified_warning`;
the reviewer cannot invent a new blocker kind during a run.

## Closed review vocabulary

The initial shared blocker vocabulary is:

- `structural_image_family_failure`
- `material_prior_truncation`
- `sampling_pathology`
- `pathological_source_reconstruction`
- `source_bbox_truncation`
- `regularization_pathology`
- `unsupported_stage_drift`

The initial shared warning vocabulary is:

- `model_limited_residual`
- `prior_boundary_contact`
- `source_sign_structure`
- `source_clumpiness`
- `supported_stage_drift`
- `uniform_like_regularization`
- `visual_prior_conflict`
- `unclassified_warning`

Each stage exposes only the relevant subset below. Updating the closed vocabulary is a reviewed workflow change, not an action available to a running reviewer.

## Stage A — coarse topology and initialization

Stage A establishes a credible coarse lensing topology and downstream initialization. It is not a final photometric fit.

Progression requires:

- healthy execution and sampling;
- identifiable main lensed features after coarse lens-light subtraction;
- a modeled counterpart for every principal arc or counterimage;
- plausible critical-curve geometry, mass center, and Einstein scale;
- posterior information suitable for downstream initialization.

Warnings include local or clumpy residuals inside an already captured image family, rough lens-light subtraction, source complexity beyond the parametric model, local brightness or width mismatch, non-material nuisance-parameter boundary contact, and a `visual_prior_conflict` when the posterior disagrees with the preflight hint but the principal image family remains credibly modeled. Visual-prior diagnostics have no mechanical conflict threshold and cannot by themselves create a blocker, retry, or human-review outcome.

Blockers include a missing or unsupported principal image, lens-light residual mistaken for a lensed-image family, uncertain image correspondence, an unsupported topology, sampling pathology, or Material Prior Truncation of a downstream-relevant parameter.

## Stage B — arc-mask refinement

Stage B's persistent Arc Mask Expert owns scientific acceptance, deterministic refinement proposals,
and uncertain routing. `supported_partial` means the predicted position is mechanically covered,
but credible associated extended signal is omitted. Its existing `evidence` entries must cite current
diagnostics, locate the omission, and explain the signal association; no automatic area-fraction
threshold establishes sufficient coverage. `supported_uncovered` still requires mechanical
non-coverage. Parameter refinement requires at least one of these two repairable states and permits
no unsupported or indeterminate prediction. Repair coverage first, then select independent unrelated
components: selection and acceptance both require every image to be `covered_consistent`, and
acceptance additionally requires no unrelated component remaining. Selection must preserve covered
predicted positions. Every retry is reviewed again; new omissions after selection return to parameter
refinement when safe, which invalidates previous selections, or to `coverage_blocked` when no safe
permitted repair remains. Arc-contaminant merges still require Human Review.
These rules supersede the retry eligibility described in ADRs 0026 and 0027. Historical artifacts are
not rewritten, but newly submitted responses must follow these rules. A Stage-B Hard Gate or
response-contract failure still uses the shared terminal `human_review` status with
`reason_kind: operational_failure`.

The persisted `feature_mask.fits` describes lensed-source support only. It is not reused as a
lens-light exclusion mask.

`refinement_kind: coverage_blocked` requests Human Review when all predicted images are supported
but at least one remains `supported_uncovered` or `supported_partial` and permitted adjustments
cannot safely recover the omitted signal. Preserve each image's scientific classification and cite
the diagnostic location and credible signal in its `evidence`; explain the exhausted or unsafe
repairs in `reason`. Both `retry_repair` and `component_selection` must be null; a development
recommendation remains optional. Adjudication records `human_review` with
`reason_kind: scientific_blocker` without requiring a retry proposal or an exhausted retry budget.
Any unsupported or indeterminate prediction still uses `uncertain`; a fully covered family cannot
use `coverage_blocked`. The expert assesses repair safety from diagnostics; the validators check
the response structure and classification consistency, not the scientific meaning of free text.

## Stage M0 — global regularization calibration

M0 fixes the Stage-A SIE+shear model, subtracts the Stage-A lens-light model, and searches for a global regularization strength. Its initial Source Grid Footprint is centred on the Stage-A posterior-median source centre and spans `±0.8 arcsec`, with `80×80` pixels at `0.02 arcsec` per pixel.

After the numerical Hard Gate passes, a persistent Stage-M0 Expert reviews only Source Grid Sufficiency using `stage_m0_source_grid.png` and its continuous edge-flux evidence. Confirmed coherent truncation advances the fixed symmetric sequence `±0.8 → ±1.0 → ±1.2 arcsec` and repeats the complete M0 calibration. The expert never selects a numerical size. Ambiguous evidence, or confirmed truncation at the maximum footprint, routes to Human Review. Acceptance seals `source_grid_spec.json` for M1–M3. General residual, mass, source-sign, and source-plausibility quality remain outside M0 review.

## Stage M1 — SIE+shear basin and source template

M1 must locate a credible SIE+shear solution basin on the M0-Sealed Source Grid and produce a usable source template for M2 and M3.

Progression requires:

- healthy sampling and interior downstream-relevant posteriors;
- consistent modeling of the principal image family and critical-curve geometry;
- Stage-A to M1 evolution that remains in an observation-supported topology;
- a Coherent Pixelized Source, with a safety check that its principal emission is not newly shown to be truncated by the M0-Sealed Source Grid.

Clumpy or asymmetric structure, local few-sigma residuals, supported mass-parameter drift, and source-sign structure are warnings. A de-magnified image-plane copy, boundary-only over-magnified solution, noise-dominated source, confirmed source-bounding-box truncation, unsupported topology change, or Material Prior Truncation is a blocker. M1 cannot resize or roll back the sealed grid; confirmed new truncation routes to Human Review, while evidence that cannot distinguish truncation from boundary pathology routes as Scientific Uncertainty.

The lens `102018665_NEG570040238507752998` M1 result is the canonical warning-only acceptance regression: it must produce no blockers and must advance with warnings for local residual and source-sign structure.

## Stage M2 — adaptive-regularization calibration

M2 fixes the M1 SIE+shear mass parameters and source template and calibrates `log_lambda_reg` and `adaptive_reg_rho`. It cannot repair mass geometry.

Progression requires healthy sampling, usable hyperparameter posteriors, a finite and stable regularization map, and preservation of the M1 source's principal coherent structure. Residual inherited from M1, clumpy structure, non-dominant negative values, limited visual improvement, or `rho` near zero are warnings.

Materially truncated hyperparameters, pathological smoothing that erases principal emission, under-regularized pixel-scale noise, non-finite maps, or unstable source solves are blockers. Arc residual alone cannot justify an M2 retry.

## Stage M3 — final scientific result

M3 applies Final Scientific Acceptance within the simple EPL+shear model family.

M3 reuses the M0-Sealed Source Grid unchanged. It performs the same final safety check as M1: confirmed newly visible truncation routes to Human Review, ambiguous truncation evidence routes as Scientific Uncertainty, and neither outcome authorizes grid adjustment or rollback.

Acceptance requires:

- healthy sampling and downstream-relevant posteriors;
- consistent modeled counterparts for all principal lensed images;
- credible critical curves and global lensing topology;
- stable or observation-supported M1-to-M3 parameter evolution;
- a Coherent Pixelized Source;
- no unresolved global residual pattern that changes the final mass interpretation.

Local model-limited residuals, real source clumpiness, source-sign structure, and localized limitations attributable to PSF, the fixed Stage-A lens-light decomposition, or the simple mass family may be recorded as final scientific limitations. Missing or unsupported principal images, global topology mismatch, pathological sources, Material Prior Truncation, unsupported mass drift, or residuals that make the final mass conclusion unreliable are blockers.

## Prior-boundary evidence

Prior Boundary Contact is not an automatic retry. A boundary becomes a blocker only when a downstream-relevant posterior is materially truncated by an artificial limit.

Each sampled parameter reports continuous diagnostics:

- prior lower and upper limits;
- q16, q50, and q84;
- distance from each quantile to the nearest limit;
- distance normalized by posterior width and prior width;
- posterior mass in documented near-boundary reference bands.

No uncalibrated diagnostic threshold creates a blocker. A prior may be widened only through a Retry Repair Hypothesis when the limit is artificial and the extension remains physically valid. Physical limits are never mechanically overridden.

## Source-sign evidence

Negative source values are evidence, not a categorical veto. M0–M3 report:

- negative pixel fraction;
- negative-to-positive integrated flux ratio;
- negative-to-positive peak-amplitude ratio;
- positive and negative flux fractions at the source bounding-box edge;
- non-finite source values.

No source-sign hard threshold is introduced before calibration on frozen accepted and rejected lenses. The reviewer combines these metrics with source morphology and image-plane consistency.

## Residual evidence

Normalized-residual diagnostics report:

- RMS;
- fractions of pixels above absolute 3σ and 5σ;
- count and maximum area of connected positive and negative significant regions;
- statistics inside and outside the Stage-B arc region where available;
- overlap between significant residuals and modeled lensed-image support.

These metrics do not replace morphology review and do not create universal hard thresholds. They help distinguish Model-Limited Residuals from complete missing or unsupported image families.

## Warning propagation

Warnings from an accepted stage are inputs to every downstream review. Each downstream Stage Review marks them `resolved`, `persisted`, or `worsened`. Persistence alone never promotes a warning to a blocker; new evidence must satisfy a closed blocker definition. Unresolved M3 warnings that do not alter the final scientific conclusion become documented final limitations.

## Retry and tuning

The existing budgets remain ceilings: at most five retries per non-B stage, fifteen shared retries per lens across A and M0–M3, and ten independent Stage-B refinements. Budget availability never creates a reason to retry.

Every scientific retry requires exactly one Retry Repair Hypothesis. The persistent
Stage Reviewer returns that hypothesis and one typed, absolute-value
proposal in the same response that identifies the Progression Blocker. There is no
separate Model Tuner and no generated Python or configuration diff. Attempt
Preparation validates the complete response and then:

- accepts exactly one parameter from the stage-local Tunable Catalog;
- checks its exact type, physical/resource envelope, and cross-field constraints;
- confirms the old value and base configuration identify the immediate candidate;
- materializes a new complete attempt-local configuration without changing any
  unrelated setting or upstream stage.

The reviewer chooses the value directly from the displayed safety envelope; the
orchestrator does not impose a tuning ladder. Invalid responses may be corrected
twice in the same reviewer session and never launch a physical attempt or consume a
scientific retry.

An unchanged rerun is not a scientific retry. If no credible stage-local repair exists, the result is accepted with warnings or routed to human review according to whether a blocker exists. Accepted upstream stages are never rolled back automatically.

## Human-review reasons

The terminal status remains `human_review`. Its decision artifact preserves:

- `reason_kind: scientific_blocker` for an unresolved blocker outside the simple workflow or without a remaining valid repair;
- `reason_kind: operational_failure` when timeout, crash, missing artifacts, non-finite output, solver failure, or response-contract failure prevents a valid attempt.

Warnings, local residuals, clumpy sources, and non-dominant negative source values are never sufficient human-review reasons.

## Golden evaluation

Every reviewed stage has paired cases for:

1. accept with zero or more warnings;
2. retry with one blocker and one valid repair hypothesis;
3. human review with one blocker and no valid repair.

Pairs explicitly distinguish local residual from missing image, clumpy coherent source from image-plane copy, uniform-like regularization from pathological smoothing, and final local limitation from global topology failure.

Generated run artifacts remain under the selected output directory and are not committed. Golden
manifests record lens ID, review focus, and expected classification without runtime artifact
hashes. Small committed schema fixtures test deterministic decision mapping independently of
physical artifacts.

## Implemented components

- The Stage Reviewer prompt uses a validated closed-vocabulary output schema.
- The `stage_decision_maker` agent and its orchestration lifecycle are removed.
- The orchestrator derives and persists `decision.json`.
- Eligible M0 results bypass generic review.
- Stage results expose continuous source-sign, prior-boundary, and residual diagnostics.
- M0–M3 use the lens-light model saved by Stage A.
- Golden contracts cover accept, retry, and human-review outcomes for every reviewed stage,
  including the canonical M1 case.
- Lifecycle, diagnostics, summary, and configuration behavior are covered by tests; generated run
  artifacts remain outside version control.
# Current workflow note

The stage-specific scientific criteria in this document remain active. The generic read-only Stage
Reviewer, read-only Arc Mask Expert, and orchestrator-owned stage loop described below are
superseded by [ADR 0018](../adr/0018-stage-experts-and-deterministic-adjudication.md): independent
Stage Experts now own execution and review, and Python Stage Adjudication registers deterministic
decisions.
