# Historical combined stage review guide

This file preserves stage criteria from the previous combined-review design. It is not the semantic
authority for blocker or warning terms; use `stage-review-glossary.md`. Current Stage Experts load
that glossary and receive their stage-specific criteria from `.codex/agents/stage-*-expert.toml`.
Operational behavior is authoritative only in `stage-expert-loop.md`.

The former Stage Reviewer handled only eligible A, M1, M2, and M3 results. A–M2 used
Progression Acceptance: the current result must be safe and useful for the next stage, not a
finished photometric model. M3 alone uses Final Scientific Acceptance. Stage B remains the Arc
Mask Expert's responsibility. ADR 0025 later replaced deterministic M0 advancement with a
grid-sufficiency-only Stage-M0 Expert.

Every finding must cite an artifact and a visible or numerical observation. Prior, source-sign,
and residual metrics are evidence; none is an uncalibrated automatic blocker threshold.

## Closed vocabulary

Blockers:

- `structural_image_family_failure`
- `material_prior_truncation`
- `sampling_pathology`
- `pathological_source_reconstruction`
- `source_bbox_truncation`
- `regularization_pathology`
- `unsupported_stage_drift`

Warnings:

- `model_limited_residual`
- `prior_boundary_contact`
- `source_sign_structure`
- `source_clumpiness`
- `supported_stage_drift`
- `uniform_like_regularization`
- `visual_prior_conflict`
- `unclassified_warning`

A phenomenon outside the closed blocker vocabulary is `unclassified_warning`, never a newly
invented blocker. The authoritative definitions and classification boundaries for every term are
in `stage-review-glossary.md`.

## Stage A: coarse topology and initialization

Allowed blockers: `structural_image_family_failure`, `material_prior_truncation`,
`sampling_pathology`.

Allowed warnings: `model_limited_residual`, `prior_boundary_contact`, `visual_prior_conflict`,
`unclassified_warning`.

Require a modeled counterpart for every principal arc/counterimage, plausible critical-curve
geometry, mass centre and Einstein scale, healthy sampling, and information suitable for
initializing downstream stages. Local or clumpy normalized residual, rough lens-light
subtraction, source complexity beyond the parametric source, and local brightness/width mismatch
are warnings when the principal image family is captured. A missing or unsupported principal
image, lens-light residual mistaken for a lensed image, or uncertain topology is a blocker.

When `visual_prior_conflict_diagnostics` show that the posterior lies away from the Visual
Einstein-Radius Hint, classify `visual_prior_conflict` only after checking the image-family and
critical-curve evidence. The disagreement has no mechanical sigma threshold and is never by itself
a blocker, retry instruction, or reason for human review. If the principal family is reproduced,
advance with the warning; use an existing blocker only when independent morphology, truncation, or
sampling evidence satisfies that blocker's definition.

Allowed one-setting repair targets are exactly `stage_a_n_live` and `stage_a_n_eff` in the current
Pipeline Release. A prior-truncation blocker without an authorized current-release target routes
to human review.

## Stage M1: SIE+shear basin and source template

Allowed blockers: `structural_image_family_failure`, `material_prior_truncation`,
`sampling_pathology`, `pathological_source_reconstruction`, `source_bbox_truncation`,
`unsupported_stage_drift`.

Allowed warnings: `model_limited_residual`, `prior_boundary_contact`, `source_sign_structure`,
`source_clumpiness`, `supported_stage_drift`, `unclassified_warning`.

Require a credible SIE+shear basin, consistent principal image family and critical curves,
observation-supported A→M1 evolution, and a coherent pixelized source whose principal emission is
not clipped by the fixed M0-Sealed Source Grid. Apply the glossary's conjunction of coherent
interior emission, visible continuation to an edge, and visible clipping; edge-flux metrics are
continuous supporting evidence and never an automatic threshold. A high-redshift source may contain
one or more physical bright clumps and need not be globally smooth. Local few-sigma residual,
asymmetry, supported mass drift, and source-sign structure are warnings. A noise-dominated source,
de-magnified image-plane copy, boundary-only over-magnified solution, source-edge truncation, or
unsupported topology change is a blocker.

`102018665_NEG570040238507752998` is the canonical warning-only M1 regression: its reviewed
result advances with local-residual and source-sign warnings and no blocker.

Allowed one-setting repair targets are exactly `stage_m1_n_live` and `stage_m1_n_eff`. The fixed
source grid has no M1-local repair, so `source_bbox_truncation` routes to human review.

## Stage M2: adaptive-regularization calibration

Allowed blockers: `material_prior_truncation`, `sampling_pathology`,
`regularization_pathology`.

Allowed warnings: `model_limited_residual`, `prior_boundary_contact`, `source_sign_structure`,
`source_clumpiness`, `uniform_like_regularization`, `unclassified_warning`.

M2 fixes the M1 SIE+shear mass geometry and cannot repair it. Require usable `log_lambda_reg` and
`adaptive_reg_rho` posteriors, a finite stable regularization map, and preservation of the M1
source's coherent structure. Inherited arc residual, limited visual improvement, non-dominant
negative values, clumpiness, or rho near zero are warnings. Material hyperparameter truncation,
pixel-scale noise, pathological smoothing that erases principal emission, a non-finite map, or an
unstable source solve is a blocker. Arc residual alone cannot justify retry.

Allowed one-setting repair targets are exactly `adaptive_reg_rho_prior_max`,
`stage_m2_n_live`, and `stage_m2_n_eff`.

## Stage M3: final scientific result

Allowed blockers: `structural_image_family_failure`, `material_prior_truncation`,
`sampling_pathology`, `pathological_source_reconstruction`, `source_bbox_truncation`,
`unsupported_stage_drift`.

Allowed warnings: every closed warning kind.

Require modeled counterparts for all principal lensed images, credible critical curves/global
topology, stable or observation-supported M1→M3 evolution, a coherent source, and no global
residual pattern that changes the mass interpretation. Local model-limited residual, physical
source clumpiness, source-sign structure, and localized PSF/lens-light/simple-mass-family
limitations may remain final warnings. Final acceptance does not require every residual pixel to
be white noise.

Apply the glossary's complete `source_bbox_truncation` criterion again because M3 first frees the
EPL radial slope on the same fixed M0-Sealed Source Grid. Allowed one-setting repair targets
are exactly `stage_m3_n_live` and `stage_m3_n_eff`. Source-grid truncation and M3 prior truncation
have no current-release M3-local repair and therefore cannot trigger an upstream rollback.

## Warning updates and retry hypothesis

For every warning supplied from accepted upstream reviews, emit exactly one update:
`resolved`, `persisted`, or `worsened`, with current-stage evidence. Persistence alone never
creates a blocker.

Return at most one atomic `retry_repair`. Its hypothesis must match one reported blocker and state
the expected evidence change. Its proposal must name exactly one allowlisted current-stage target,
echo the current value and config path, and choose one concrete absolute new value inside the
review context's safety envelope. Use null if the failure is not credibly repairable by one local
setting. Do not request an unchanged rerun or rollback of an accepted upstream stage.
