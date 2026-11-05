---
status: accepted
---

# Require a high-significance core for every preflight segment

Fresh preflight runs will use Core-Seeded Segmentation as the single authoritative segmentation for the Inspector figures, `segmentation.fits`, contaminant IDs, and the Modeling Mask. A lower-significance, deblended footprint is retained in full only when it overlaps a spatially coherent higher-significance detection core; isolated lower-significance islands are discarded instead of being hidden only in the display. The rule has no boundary-crossing exception, surviving segments are relabelled consecutively, and an image with no qualifying core produces a valid empty segmentation rather than silently falling back to the lower threshold. Both the three-panel Inspector prompt and six-panel human audit show only the final retained lower-significance footprints and IDs; the higher-significance cores are selection evidence, not an additional visual overlay. The inspection packet records the fixed release-owned thresholds, minimum connected area, and segment counts before and after filtering under a new schema version; these settings are not lens-local tunables. This preserves faint signal outskirts while reducing noise-only visual structure, keeps displayed IDs identical to maskable IDs, and requires a new Pipeline Release plus fresh preflight rather than mutation of an existing Lens Run.

ADR 0017 supersedes only this decision's uniform presentation of retained segments; the authoritative footprint-retention, relabelling, ID-maskability, and core-geometry rules above remain in force.

Activation requires deterministic segmentation tests, human inspection of regenerated three- and six-panel figures for the two diagnosed lenses, the complete fast test suite, and syntax checks. Production-model old-versus-new Inspector trials are deliberately left to the user and are not claimed as implementation evidence; until that external visual regression is completed, the change demonstrates deterministic noise-island suppression but not a measured improvement in model classification accuracy.
