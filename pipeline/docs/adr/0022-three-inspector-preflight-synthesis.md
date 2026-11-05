---
status: accepted
date: 2026-08-30
---

# Synthesize three independent System Inspector reports without another image review

For every fresh preflight, the Lens Orchestrator will delegate exactly three System Inspectors in parallel. Each inspector independently reviews the same Preflight Inspector Prompt with the same role and cannot see the other responses; no individual response is authoritative. The inspectors remain simple one-shot visual experts rather than becoming nested orchestrators, while their three valid responses are retained as System Inspector Votes.

A separate, dedicated Preflight Synthesis Expert will always read the three complete reports and produce the final structured result. It receives only the fixed `lens_id` and the three vote-file paths, receives no preflight image or other visual artifact, and therefore contributes no fourth visual interpretation. Its role is to synthesize the inspectors' reported evidence, agreements, disagreements, and reasoning in text and structured fields. The final `disposition` must follow the two-of-three majority, so the synthesis expert may explain a minority opinion but cannot promote it over the majority routing decision.

Every displayed segmentation ID is resolved independently: it enters the final `contaminant_ids` only when at least two votes contain it, while an ID reported by only one inspector is excluded as a possible isolated hallucination. Coordinates and morphology statements must derive from the reports. A `model` synthesis selects one complete `theta_E_hint` from a vote in the majority `model` set rather than combining its fields or inventing a new hint; a `human_review` synthesis always uses `theta_E_hint: null`. The synthesis expert may rewrite `reason` to summarize the majority, the minority, and its hint-selection rationale, but must not claim direct image evidence.

The synthesis expert is read-only and returns the existing strict five-field JSON. The Lens Orchestrator submits that temporary response for deterministic synthesis validation, which registers `preflight/synthesis.json`, and then submits the registered synthesis to the existing mask command; only the resulting `preflight/inspector.json` and Modeling Mask are authoritative downstream. The three votes remain separate audit evidence. The existing response-correction allowance and operational-stop behavior remain sufficient for invalid model output; this change introduces no replacement-inspector or reduced-quorum recovery protocol. If a session is interrupted before canonical `preflight/inspector.json` exists, resume reruns all three inspections and the synthesis rather than mixing partial votes from different sessions.

Before mask materialization, deterministic Preflight Synthesis Validation checks the fixed `lens_id` and strict five-field contract, the two-of-three `disposition`, per-ID two-of-three membership, complete hint equality with one vote from the majority `model` set, and the required null hint for `human_review`. Validation only rejects an invalid synthesis and reports the mismatch to the same synthesis expert under the existing response-correction allowance; it never calculates, replaces, or silently repairs the expert's output.

This changes the preflight decision and artifact protocol but not the fixed physical model. It therefore creates a new Pipeline Release and applies only to a fresh Lens Run; existing Lens Runs remain read-only under their recorded release.
