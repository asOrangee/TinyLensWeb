> Distribution note: original observation images and real-run outputs are not bundled.
> Schema and synthetic unit tests remain available. To run image/real-stage AI evaluations,
> provide your own files and update manifest paths and hashes.

# LLM regression evaluations

## System Inspector

This evaluation keeps human-reviewed labels separate from each isolated LLM invocation. The model
receives only the current inspector prompt and one copied two-panel PNG; it cannot see the golden
manifest.

The immutable, human-reviewed PNG fixtures live under `.codex/evals/images/` and are tracked with
the evaluation framework. The active golden set contains 18 Euclid simple-lens cases rendered by
the production two-panel renderer, including the one-pixel context margin outside the 4″ circle.
All 18 cases have `expected_disposition = "model"`; this set measures preservation of lensing
features and exact VIS contaminant inventories, not `human_review` recall. Their SHA-256 values are
recorded in the golden manifest. Verify them with:

```bash
python \
  -m lens_agent.evaluation.system_inspector prepare
```

Run three independent trials per case:

```bash
python \
  -m lens_agent.evaluation.system_inspector run --trials 3
```

By default, the evaluation inherits `model`, `model_reasoning_effort`, and
`developer_instructions` from `../agents/system-inspector.toml`. The golden manifest contains no
runtime model defaults. `run --model MODEL` and `run --reasoning-effort EFFORT` independently
override those values for that invocation only; metadata records both the agent defaults and the
effective values.

Each run is written below `output/system_inspector_evals/<timestamp>/` with raw predictions, Codex
logs, `report.json`, and `report.md`. The report includes contract compliance, disposition accuracy,
exact-match rate, missed IDs, over-masked IDs, micro precision/recall/F1, and cross-trial stability.
Comparisons continue when the effective model, reasoning effort, prompt, or fixtures differ, but
the comparison report lists those differences as a comparability warning.

Compare a new prompt run against a saved baseline:

```bash
python \
  -m lens_agent.evaluation.system_inspector compare \
  output/system_inspector_evals/BASELINE/report.json \
  output/system_inspector_evals/CURRENT/report.json
```

Use `score --run-dir <run>` to regenerate reports after manually correcting or importing prediction
JSON files. Add a golden case only after human review; record its immutable image SHA-256 and sorted
expected contamination IDs in `system-inspector-golden.toml`.

The human-reviewed source batch contained 20 systems. Two are deliberately excluded from this
active simple-lens regression set:

- `102018668_NEG595646727509469177`: double-source lensing, outside the intended capability tested
  by this simple-system set.
- `102019128_NEG608928997504779012`: a `human_review` case, excluded by the dataset curation
  decision for this 18-case model-only baseline.

The expected contaminant inventories incorporate the human corrections recorded during curation:
IDs 55 and 56 are lensed images in `102018666_NEG579859279508531437`; IDs 37 and 39 are lensed-image
features in `102019123_NEG564667438505382529`; IDs 30–33 are lens-system features in
`102019125_NEG586359480506090347`; ID 45 is a lensed image and ID 46 is contamination in
`102019586_NEG564463213499964061`; and ID 34 is the lens galaxy while IDs 18 and 35 are lensed
images in `102019591_NEG601417531499600002`.

The earlier two-case fixtures were retired during this curation: the plain six-panel and
`_3panel.png` renders were deleted, and the two surviving cases were re-rendered and re-reviewed
with the current production two-panel renderer. The old renders described a superseded prompt
layout and duplicated audit material, so they were removed rather than kept alongside. The
six-panel human audit remains part of the production preflight; only its stale fixture copies
were dropped.

## Stage Experts

`stage-{a,m1,m2,m3}-expert-output.schema.json` provides an independent closed contract for each
physical-modeling expert, while `stage-b-expert-output.schema.json` covers arc-mask refinement
without an Agent-supplied decision field. The matching `stage-*-expert-golden.toml` manifests each
record an accept/retry/human-review triad. `stage-expert-contract-cases.json` is the shared
set of complete scientific fixtures; the test suite validates each fixture against its assigned
stage schema, closed classifications, and repair-to-blocker link.

`stage-review-decision-cases.json` isolates the deterministic mapping from hard-gate eligibility,
blockers, repair validity, and remaining budget to the persisted decision. Production Stage
Adjudication now enforces this mapping without introducing a Python workflow state machine.

The sole semantic authority for blocker and warning terms is
`.codex/skills/lens-model-orchestrator/references/stage-review-glossary.md`. The authoritative
machine policy for each stage's allowed subset lives in `src/lens_agent/review_vocabulary.py`.
Synchronize its generated copies in the four non-B Expert schemas after changing that policy:

```bash
python -m lens_agent.evaluation.stage_expert_schemas --write
```

The test suite checks the same relationship. A read-only check is also available with `--check`.

## Real-artifact Stage A / M1 review comparison

`python -m lens_agent.evaluation.stage_review` snapshots explicitly allowlisted JSON/PNG evidence
from existing, hard-gate-eligible attempts. It runs scientific review only: no physical stage,
adjudication, retry, promotion, or writes to original run directories. Historical evidence is
retained without converting its scientific fields to a newer schema. Optional `fixture_note`
describes historical provenance identically for both prompt variants.

```bash
python -m lens_agent.evaluation.stage_review prepare --variant baseline --prompt-ref <baseline-commit>
python -m lens_agent.evaluation.stage_review prepare --variant candidate
python -m lens_agent.evaluation.stage_review run --snapshot /srv/TinyLensWeb/pipeline/lens_run_prompt_evals/baseline
python -m lens_agent.evaluation.stage_review run --snapshot /srv/TinyLensWeb/pipeline/lens_run_prompt_evals/candidate
python -m lens_agent.evaluation.stage_review compare --baseline /srv/TinyLensWeb/pipeline/lens_run_prompt_evals/baseline --candidate /srv/TinyLensWeb/pipeline/lens_run_prompt_evals/candidate
```

Replace `<baseline-commit>` with the commit before the prompt edits. Preparation accepts
`--manifest` and `--output-dir`; each variant must be new. The default manifest is
`stage-review-real-cases.toml`. Each case supplies `id`, `stage`, `attempt_dir`, `expected_outcome`
(`continue` or `stop`), and relative `evidence` paths; `upstream_evidence` is an optional explicit
list of upstream JSON/PNG paths. Expectations remain in parent-only metadata. No recursive run
directory copying is performed. `review.json`, `decision.json`, accepted-head directories,
execution records and manifests are rejected; nested decision/label fields and absolute paths
are removed from copied JSON. Upstream warnings remain available.

The initial manifest contains the two user-identified Stage-A progression cases and the historical
M1 warning-only regression. The M1 fixture used EPL+shear in that release; its identical provenance
note limits this test to scientific review of those recorded results, not current SIE execution or
source-grid sealing. This positive-only set cannot measure false acceptance. The proposed negative
control is `102020064_NEG630441470494718517/attempts/a/0` in `lens_run`, where the northeast arc has
no extended-model counterpart. Its replacement-case label awaits user confirmation before inclusion
in the scored manifest; the initially proposed earlier failed attempt of
`102018666_NEG579859279508531437` was not found among the available artifacts.

Each fresh Codex invocation receives inline JSON and attached PNGs, snapshot agent instructions,
the shared glossary and operational loop, plus a review-only override. Runs default to three
trials using each expert's configured model/reasoning; explicit `--model` and `--reasoning-effort`
overrides are recorded. Comparison requires identical evidence, schemas, cases, trials and runtime.
`run --jobs 3` evaluates up to three independent cases concurrently; the default is one. Each
case's trials remain serial and use distinct output directories. A shared backend-failure flag
prevents starting later cases or trials; already-running children finish before reporting.
Original and copied evidence, schemas and prompt snapshots are checksum-verified. Raw responses
and event logs accompany `report.json` and `report.md`; `score --snapshot <path>` recomputes
scoring, including missing or invalid responses as failures. The protocol version and evaluator
source checksum are recorded at preparation, execution and scoring. A backend invocation failure
stops further requests; remaining trials count as missing failures. `compare` writes
`comparison/comparison.json` and `comparison/comparison.md` under the candidate snapshot by
default; `--output-dir` can choose another directory within the same evaluation output root.

The existing strict stage schema and production response validator validate outputs; every
unresolved upstream warning must be updated exactly once. A generation-only schema projection
supplies the backend's required explicit constant types; full canonical validation remains intact.
The backend supports only a [subset of JSON Schema](https://developers.openai.com/api/docs/guides/structured-outputs);
the projection is local to this evaluator and does not change any production output schema.
The reported
`continue`/`stop` outcome follows accept eligibility: blockers or scientific uncertainty stop
progression. `retry_requested` is reported separately; this harness does not claim full retry
adjudication, which requires production repair validation and retry budgets. A passing label must
also undergo human inspection of the scientific reasoning. Small curated samples do not establish
performance across the entire lens batch.

Isolation limitation: `read-only` prevents child filesystem writes but does not deny all absolute
filesystem reads. Shell, apps, multi-agent and web search are disabled; child instructions prohibit
all tool calls, and detected tool events invalidate a trial. The evaluator provides bounded inputs
and audited compliance, not OS-enforced secrecy of original files. It ignores user configuration
and rules and starts an ephemeral session in a temporary directory. Do not interpret these controls
as a general-purpose secure sandbox.
