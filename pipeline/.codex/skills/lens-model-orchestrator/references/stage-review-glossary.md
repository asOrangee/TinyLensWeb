# Stage Review Scientific Glossary

This file is the sole semantic authority for the closed scientific blocker and warning terms used
by the Stage Experts. Stage-specific response schemas remain the machine authority for which subset
is allowed at each stage. Stage-B refinement kinds, warning-lineage statuses, and operational
failure codes are outside this glossary.

Every finding must cite an artifact and a visible or numerical observation. Diagnostics are
continuous evidence, not uncalibrated automatic thresholds. Classify the directly observed failure;
do not infer a more repairable cause merely because a retry target exists. A phenomenon outside the
closed blocker vocabulary is an `unclassified_warning`, never a newly invented blocker. Persistence
or worsening of a warning does not create a blocker without new evidence satisfying a blocker
below.

## Image correspondence and stage capability

A principal image is an observed arc or counterimage whose presence and broad geometry constrain
the lensing interpretation. Assess correspondence at the scale of the whole arc or counterimage:
position, radial scale, tangential orientation, azimuthal extent, and relative layout. A brightness
peak, knot, or locally unmatched extension within or adjacent to an otherwise captured arc is not
automatically a separate principal image. Explain its role in the image family from the spatial
evidence rather than counting peaks or significant residual islands.

The Stage-A Predicted Image Family solves the lens equation for the posterior-median source
centre as a point. Its complete list is complete for that point, not for the extended source.
Other source positions, including clumps on different sides of a caustic, can have different image
positions and multiplicities. Use these predictions as geometric anchors alongside the extended
Lensed Image Model; a local knot need not coincide with a predicted anchor. This distinction does
not excuse an entire observed principal arc with no plausible extended-model counterpart.

A through M2 use Progression Acceptance: the result must provide usable information for the next
stage within the current model's capability. When the principal geometry is credible, record local
brightness, width, clump, and extension mismatches as warnings, including local attribution that
remains uncertain. Establishing whether such a residual comes from source structure, lens-light
subtraction, or another local limitation need not precede progression. State what remains uncertain
and what downstream evidence should test it; do not assert that a later stage will remove it.
M0's scientific review remains restricted to source-grid sufficiency. M3 applies Final Scientific
Acceptance: remaining limitations must leave the final mass interpretation credible, which does
not require a noise-only residual map.

## Blockers

### `structural_image_family_failure`

A credible principal observed arc or counterimage lacks a modeled counterpart, the model predicts
an unsupported principal image, lens-light residuals dominate the claimed image correspondence, or
the principal image family and critical-curve topology cannot form one credible interpretation.
Do not use it for a local brightness, width, PSF, lens-light-subtraction, or normalized-residual
mismatch when the principal image family remains captured and the mass interpretation is intact.

For this blocker, the existing evidence and impact fields must locate the principal missing or
unsupported structure, compare its whole-image geometry with the extended model, and explain why
the discrepancy invalidates the current stage's image-family interpretation or downstream use.
Test plausible local source-complexity and lens-light explanations against the same diagnostics.
Residual significance, lack of a source-centre prediction at a knot, or uncertain local attribution
alone do not establish that consequence. Unresolved alternatives are blocking when both are
observation-supported, cannot coexist under the coarse topology, and choosing between them changes
the principal image family or material mass interpretation.

### `material_prior_truncation`

An artificial prior limit that can be safely extended within the physical model cuts off posterior
support that remains boundary-seeking rather than turning over inside the allowed interval, and the
excluded support could materially change the current stage's scientific interpretation or
downstream initialization. Evidence must identify the affected parameter, the artificial limit,
why it is safely extendable, the posterior shape at that limit, and the scientific consequence.
Near-boundary quantiles, normalized distances, or posterior mass alone are insufficient. A
physical or non-extendable limit is never mechanically widened or classified as material prior
truncation merely because posterior support reaches it.

### `sampling_pathology`

The sampling process does not stably and credibly represent the target posterior. Evidence may
include materially inconsistent posterior support across sampling diagnostics or instability at the
current sampling budget. A broad but stable posterior, a reproducibly sampled multimodal
posterior, prior-boundary contact, structural model failure, timeout, or missing artifact is not a
sampling pathology.

### `pathological_source_reconstruction`

A Stage-M1 or Stage-M3 mass-modeling solution produces at least one of these source-plane
morphologies:

- unstructured, pixel-scale noise dominates instead of coherent source emission;
- a de-magnified solution resembles a reduced copy of the image-plane arc or configuration,
  consistent with mass normalization being too low for the observed image configuration;
- an over-magnified boundary-only solution has bright pixels confined to the source-grid boundary
  and no corresponding coherent bright emission in the source-plane interior, consistent with mass
  normalization being too high for the observed image configuration.

The boundary-only morphology is not the clipped continuation of an extended interior source.
Source-sign structure, physical clumpiness, and source-bounding-box truncation do not satisfy this
blocker. Negative source structure is warning evidence only and can never independently create a
blocker.

### `source_bbox_truncation`

A coherent, spatially continuous, extended brightness distribution is present in the source-plane
interior and continues to the source-grid boundary, where the same distribution shows visible
clipping. Do not use it for isolated edge noise or a boundary-only solution with no corresponding
coherent interior emission. Boundary contact without visible truncation is insufficient. Per-edge
positive-flux fractions are continuous supporting evidence and have no automatic classification
threshold.

For M0, use the signed linear source panel as the primary evidence: the same coherent interior
structure must retain material brightness relative to the principal source as it reaches the
boundary and visibly terminates there, rather than fading within the footprint. The positive
asinh panel is a locator for faint features, not independent evidence of truncation. A faint,
smooth pedestal emphasized by asinh, edge contact, or nonzero edge-flux fractions alone supports
neither enlargement nor `indeterminate` when the principal source is contained in the linear
view; return `grid_sufficient`. Such a pedestal may be regularization-driven continuation in
weakly constrained pixels, but its origin need not be established for grid acceptance. Neither
display is a statistical significance map, and linear visibility does not prove physical reality.
Do not invent a brightness or flux-fraction cutoff. With readable essential linear diagnostics,
M0 returns `source_bbox_truncation` only when clear clipping satisfies the criterion above;
otherwise it returns `grid_sufficient`, including an ambiguous connection between edge and
interior structures. Document that ambiguity as insufficient evidence for enlargement, without
claiming truncation is ruled out or the reconstruction is physically valid. Reserve M0
`indeterminate` exclusively for missing or unreadable essential linear diagnostics; identify the
artifact and the access or readability problem. Morphological ambiguity in a readable image does
not meet this condition. Record the panel and morphology supporting an image-based judgment.

At M0 this finding requests the next fixed symmetric Source Grid Enlargement. After M0 acceptance,
M1 and M3 apply the same criterion only as a safety check on the M0-Sealed Source Grid; they route
confirmed truncation to Human Review and never resize or roll back the grid. If M1 or M3
cannot distinguish clipping from a boundary-only pathology, it reports Scientific Uncertainty
rather than asserting truncation or pathology.

### `regularization_pathology`

With the accepted Stage-M1 mass geometry and source template fixed, Stage M2 does not find a
finite, stable regularization solution that preserves credible coherent source emission. Evidence
may include a non-finite regularization map, an unstable source solve, a pixel-noise-dominated
solution, pathological over-smoothing, or loss of principal emission. This blocker is specific to
Stage M2; Stage-M1 and Stage-M3 source failures use their applicable mass-modeling blocker.

### `unsupported_stage_drift`

A material change between accepted and current-stage mass parameters, mass centre, Einstein scale,
shear, ellipticity, image-family assignment, or topology changes the scientific interpretation
without support from the observed image family, critical curves, and residual evidence. Ordinary
posterior tightening, numerically small changes, or observation-supported evolution is not this
blocker.

## Warnings

### `model_limited_residual`

A localized residual remains within or immediately adjacent to an otherwise captured principal
image family and does not change the critical curves, global topology, or mass interpretation.
Evidence may attribute it to the deliberately limited PSF, lens-light decomposition, source model,
mass family, or regularization model only when the artifacts support that attribution. A missing
principal image is not a model-limited residual.
An uncertain cause can remain explicitly unresolved when the residual is demonstrably local and
the principal correspondence remains credible. Use `unclassified_warning` for a non-material local
ambiguity that cannot yet be identified as a model limitation. A warning's persistence across
stages is a monitoring result, not evidence that the next stage is unusable.

### `prior_boundary_contact`

Posterior support approaches or touches a prior limit, but the evidence does not establish both
continued support beyond an artificial boundary and a material effect on the current or downstream
scientific interpretation. This warning is not an automatic retry instruction.

### `source_sign_structure`

Spatially coherent negative source structure is scientifically worth monitoring. Source-sign
diagnostics may describe its integrated flux, peak amplitude, area, and morphology, but no
uncalibrated threshold creates a blocker. Isolated negative pixels consistent with noise need not be
reported. Source-sign structure is warning-only, regardless of its measured strength.

### `source_clumpiness`

The source contains coherent clumps or asymmetry that may be physically real and remains consistent
with the modeled lensed-image family. Do not use it for unstructured pixel noise, a de-magnified
image-plane copy, or boundary-only bright pixels.

### `supported_stage_drift`

A material stage-to-stage change in mass parameters or topology is supported by the observed image
family, critical curves, and residual evidence. Ordinary posterior tightening or a change too small
to affect the scientific interpretation need not be reported.

### `uniform_like_regularization`

Stage-M2 adaptive regularization is close to uniform, for example because `adaptive_reg_rho` is near
zero or the regularization map varies little, while the map and source solve remain finite and
stable and the accepted Stage-M1 coherent principal emission is preserved. Near-uniformity alone is
not a blocker.

### `visual_prior_conflict`

The Stage-A posterior disagrees with the preflight Visual Einstein-Radius Hint while the principal
image family and critical-curve topology remain credible. The hint and Stage-A result are correlated
interpretations of the same imaging data. Their disagreement has no fixed sigma threshold and is
never by itself a blocker, retry instruction, or reason for Human Review.

### `unclassified_warning`

An evidenced, non-blocking phenomenon needs downstream monitoring but fits no other closed warning
term. Do not use it to conceal a known blocker, avoid choosing an applicable warning, or invent a
new blocker meaning.
