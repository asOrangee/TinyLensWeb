---
status: accepted
date: 2026-08-01
---

# Remove the masked lens-only Stage L

Stage L reused the Stage-B `feature_mask.fits` as a lens-light exclusion mask, downweighted the
lensed-source support by a factor of `10000` in noise, and fitted lens light only outside that
region. In severely blended systems this deleted high-leverage constraints on the lens-light
core and produced an unvalidated central extrapolation. Stage A already obtains a lens-light
model from a joint parametric lens-light, source, and mass fit and saves the artifact required by
the downstream mass stages. The scientific evidence and limits of this conclusion are recorded
in [the Stage-L extrapolation lesson](../lessons/stage-l-arc-mask-lens-light-extrapolation.md).

The active workflow is therefore `A → B → M0 → M1 → M2 → M3`. Stage L is removed from the public
stage enum, CLI, pipeline template, diagnostics, review schema, retry policy, and evaluation
fixtures. M0–M3 load the saved Stage-A `lens_light_model`; `feature_mask.fits` describes only
lensed-source support and keeps its existing filename. The five-retry Stage-L allowance is
removed, while the shared fifteen-retry per-lens ceiling for A and M0–M3 remains unchanged.

This is a forward-only breaking change. Existing Stage-L result directories and their review
evidence remain untouched, but they are not migrated, revalidated, or resumable under the new
workflow. A new workflow run must use a new output directory.

The immediate consequence is a smaller workflow that no longer deletes blended lens-light
constraints before source reconstruction. The trade-off is that Stage-A lens light remains fixed
through M0–M3 and its lens/source allocation uncertainty is not propagated. Joint lens-light and
pixelized-source refinement is a future design direction, not part of this decision. This change
is verified by syntax, contract, CLI, and Stage-A-to-M0 data-flow tests only; it does not claim a
representative physical-modeling validation or prove that Stage L was the sole cause of any M0
non-convergence.

This ADR supersedes only the Stage-L participation and Stage-L-specific review vocabulary in
[ADR 0010](0010-stage-specific-progression-review.md). Its remaining deterministic review policy
continues to apply.
