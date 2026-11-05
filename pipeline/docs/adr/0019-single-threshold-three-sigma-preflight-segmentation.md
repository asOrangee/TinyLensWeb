---
status: accepted
supersedes: ADR-0016, ADR-0017
---

# Use one 3-sigma threshold for preflight segmentation

Fresh preflight runs use 3-Sigma Preflight Segmentation as the single authoritative segmentation for both preflight figures, `segmentation.fits`, contaminant IDs, Boundary-Crossing Segments, and the Modeling Mask. A segment is a deblended positive VIS detection containing at least five connected pixels at or above three times the background-noise scale; the background and noise estimator remain unchanged. All segments have equal visual prominence, and inspector-selected contaminants mask exactly their 3σ pixels without dilation or recovery of lower-significance outskirts.

This replaces ADR-0016's 2σ footprints retained by 3σ cores and ADR-0017's 4σ strong/weak display tiers. The simpler rule deliberately accepts narrower contaminant masks and possible fragmentation when 2–3σ bridges disappear. It activates under `three-sigma-preflight-segmentation.v1` with a new Inspection Packet schema, so an existing Lens Run remains immutable and must undergo a Full Lens Rerun to adopt the rule. Implementation acceptance requires only deterministic unit tests, the fast test suite, and syntax checks; comparative scientific and System Inspector performance evaluation is deferred to the user and is not claimed by this change.
