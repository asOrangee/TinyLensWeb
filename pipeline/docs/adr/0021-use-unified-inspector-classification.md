---
status: accepted
---

# Use unified System Inspector classification

The System Inspector uses one visual classification rule for every segmentation region instead of treating a segment that crosses the fixed 4″ modeling boundary as contamination automatically. The serialized `contaminant_ids` inventory contains every displayed segmentation ID not assigned to the dominant lens galaxy or plausible lensed images, including regions wholly outside the 4″ circle; the Modeling Mask still excludes all pixels outside that circle mechanically. This supersedes the Boundary-Crossing Segment requirements in ADR-0019 and ADR-0020 because observed boundary sources are already classified as Non-Lens Segments, while an unconditional exception can discard genuine lens-system light.

A canonical `model` disposition permits the fixed single-deflector A–M3 workflow even when the preflight morphology is not unique, and an accepted M3 result remains final. Downstream Stage Experts, rather than preflight ambiguity alone, route unresolved structural failures to Human Review. No provisional disposition or automated complex-model continuation is introduced.

The Inspector keeps the concise visual Einstein-radius request and uses ordinary visual confidence rather than prescribed ridge, anchor-family, or confidence-calibration instructions. Eligible `high` and `medium` hints still produce the existing 80% informative-core and 20% uniform-escape Stage-A prior, while `low` confidence retains the baseline uniform prior. The escape component preserves non-zero prior density but does not guarantee recovery by finite sampling. This supersedes ADR-0014 only where it required the removed prompt-calibration vocabulary; the decision schema, prior derivation, provenance, and fixed physical model are unchanged.
