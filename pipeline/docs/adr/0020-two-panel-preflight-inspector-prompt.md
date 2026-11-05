---
status: accepted
---

# Use a two-panel prompt for System Inspector

Fresh preflight runs will give the System Inspector a two-panel central prompt: an unlabelled J/Y/VIS colour composite for morphology and geometry locking, followed by the same composite with authoritative VIS segmentation contours and exact IDs for contamination mapping. The separate contour-only panel is removed because it duplicates the right panel's segmentation boundaries without adding scientific evidence; the larger remaining panels improve the display scale while retaining the one-pixel context outside the fixed 4″ aperture. Inspector segmentation boundaries use one semantically neutral white style with a thin black contrast outline, rather than per-segment colours that could be mistaken for physical colour structure; yellow IDs retain a black contrast outline, and the aperture is green so it remains distinct. The six-panel human audit, segmentation, boundary-crossing rule, and physical model remain unchanged. This supersedes ADR-0015 only for the Inspector panel count and layout; its human-audit, fresh-run, and immutability decisions remain in force. The change activates under a new Pipeline Release and applies only to fresh preflight output named `preflight_2panel.png`; existing Lens Runs and historical three-panel evaluation fixtures remain unchanged. Activation requires deterministic tests and human inspection of generated figures, while comparative System Inspector scientific-performance evaluation remains the user's separate responsibility.

> Amended 2026-08-27: the historical three-panel and six-panel evaluation fixtures were removed
> when the golden evaluation set was re-rendered and re-reviewed as the 18-case two-panel baseline
> under `.codex/evals/`. All other decisions, including the six-panel human audit in production
> preflight, remain in force.
