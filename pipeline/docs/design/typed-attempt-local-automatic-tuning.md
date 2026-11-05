# Typed Attempt-Local Automatic Tuning

Status: historical; its tuning policy is retained, while workflow ownership is superseded by
[ADR 0018](../adr/0018-stage-experts-and-deterministic-adjudication.md) and Pipeline Release
`stage-expert-adjudication.v2`.

This document records the earlier orchestrator-owned loop. Current Stage Experts drive their own
stage loops, and Python adjudication applies the retained typed tuning rules.

This document specifies the replacement for lens-local Python patching during stage retries. It
records the shared design reached on 2026-08-03 and is subordinate to the repository's immutable
run inputs, Hard Gates, review thresholds, schemas, retry budgets, and scientific routing rules.

## Goals

- Let the scientific reviewer choose a concrete stage-local parameter value without editing code.
- Avoid a second Model Tuner call and its duplicated context, latency, and tokens.
- Retain one reviewer session across a stage's eligible retries while keeping filesystem evidence
  authoritative and recoverable by a replacement reviewer.
- Run one fixed Packaged Pipeline with complete, validated, attempt-local configuration data.
- Preserve every accepted and rejected attempt's physical outputs and diagnostic images.
- Keep decisions and promotion deterministic and keep Python free of a workflow state machine.

## Non-goals

- Changing a mass model, parameterization, algorithm, or executable pipeline during a run.
- Retaining a disabled arbitrary-code or unified-diff escape hatch for future use.
- Migrating or resuming historical output roots.
- Prescribing parameter ladders, step sizes, or Python-selected next values.
- Content hashing, hash matching, artifact IDs, file-size inventories, automatic pruning, or an
  additional write-once/execution-marker protocol.

Model and Code Evolution remains future planning. Its only current seam is a run-pinned Pipeline
Release; a run cannot switch releases.

## Roles and lifecycle

### Lens Orchestrator

The Lens Orchestrator remains the workflow owner. It chooses the next stage, checks retry budgets,
delegates scientific review, derives `accept`, `retry`, or `human_review` mechanically, invokes
Attempt Preparation and physical stage execution, and advances Accepted Stage Heads. It never
hand-edits a full configuration.

### Persistent Stage Reviewer

A, M1, M2, and M3 each use one Persistent Stage Reviewer per `lens × stage`. The same session
reviews attempt 0 and every eligible scientific retry for that stage. On each turn it receives a
bounded Stage Review Context rather than the full pipeline source or full run history.

Session continuity is an optimization, not scientific state. If the session is lost or becomes
too large, an equivalent reviewer may resume from saved Stage Attempt Records and the compact retry
lineage without rerunning a stage or consuming a retry. M0 remains deterministic and has no
reviewer. Stage B retains its separate Persistent Arc Mask Expert.

The active Model Tuner role and `.codex/agents/model-tuner.toml` are removed.

## Packaged pipeline and configuration

The Packaged Pipeline is the only executable modeling implementation. It is loaded from the
installed package and is not copied into a Lens Result Directory. The public stage command no
longer accepts `--pipeline` or an arbitrary configuration path.

Every Stage Attempt Record contains a complete `effective-config.json`. The configuration includes
all effective runtime settings required by the Packaged Pipeline, including locked settings that
Automatic Parameter Tuning cannot change. It is strict: unknown fields, incorrect types, non-finite
numbers, and invalid cross-field relationships are rejected. Pydantic 2 is already a project
dependency and can own the typed configuration model and emitted JSON Schema.

An attempt-local configuration is intentionally repeated even when it equals its parent's
configuration. Configuration files are small, and a self-contained attempt is preferred over a
separate content-addressed or numbered configuration store. No configuration or artifact hashes
are computed.

Each run records a `pipeline_release_id` that binds the Packaged Pipeline, configuration schema,
Tunable Catalog, and stage artifact contract by versioned policy. Every attempt names that release,
and a run cannot switch to another release. This is a version contract, not a content hash.

## Tunable Catalog and safety envelope

The Configuration Schema says which settings exist. The Tunable Catalog separately says which
individual leaves a reviewer may change. It is explicit, stage- and role-owned, default-deny, and
contains no wildcard grants such as `stage_a_*_prior`.

For each authorized leaf, the catalog supplies the owning stage and role, repairable blocker kinds,
value type, minimal physical or resource limits, cross-field requirements, and cache/artifact
invalidation scope. Runtime validation inputs, the reviewer proposal schema, reviewer-facing
allowlists, and human-readable documentation are generated from this single machine authority or
checked against it so they cannot drift independently.

The first catalog is deliberately limited to evidence-supported leaves. Its exact leaf inventory
and hard physical/resource limits are implementation determinations that require review of the
current evaluated targets and, for resource limits, representative benchmarks. Adding a tunable is
an out-of-run policy change that requires tests and a new Pipeline Release.

Within the safety envelope, the reviewer chooses any concrete absolute value. The workflow does
not define discrete sampler levels, prior-expansion ladders, required directions, or step sizes.

## Atomic Stage Review and proposal

The reviewer emits one strict JSON response containing the complete Stage Review and an optional
Retry Repair Hypothesis and Retry Repair Proposal. A representative unrepairable fixed-grid
truncation response is:

```json
{
  "stage": "m1",
  "visual_findings": [
    "diagnostics/stage_m1_source.png: principal emission reaches the source boundary"
  ],
  "numerical_findings": ["source edge flux remains material"],
  "progression_blockers": [
    {
      "kind": "source_bbox_truncation",
      "evidence": [
        "diagnostics/stage_m1_source.png: positive emission is clipped at the upper edge"
      ],
      "impact": "the source template is unsafe for downstream adaptive regularization"
    }
  ],
  "handoff_warnings": [],
  "upstream_warning_updates": [],
  "retry_repair": null,
  "reason": "the otherwise coherent source is truncated by the current bounding box"
}
```

The exact schema uses closed parameter branches derived from the Tunable Catalog rather than
`parameter: string` plus an unconstrained value.

Decision mapping remains deterministic:

| Validated result | Derived decision |
|---|---|
| Hard Gate fails | `human_review`, operational failure; reviewer is not called |
| No Progression Blocker and no repair | `accept` |
| Exactly one blocker with one valid proposal and budget remaining | `retry` |
| Blocker without a valid local proposal, incompatible blockers, or exhausted budget | `human_review`, scientific blocker |

The reviewer never returns the final decision.

## Response correction

A response that violates the review schema or proposal contract does not run a model, create a new
stage attempt, or consume a scientific retry. The same reviewer receives structured validation
errors and may correct the response twice. A third invalid response routes the lens to
`human_review` with an operational response-contract reason. If the Orchestrator supplied stale
context, it regenerates the context without charging the reviewer correction allowance.

## Stage Review Context

Each review turn receives a machine-generated, stage-scoped view containing:

- lens, stage, and attempt;
- the current attempt-local configuration reference;
- settings consumed by the current stage, with tunability and safety-envelope information;
- current stage result and attempt-local artifact/diagnostic paths;
- the preceding retry hypothesis, proposal, and expected improvement;
- a compact attempt lineage; and
- all unresolved upstream warnings.

The full Effective Configuration Snapshot remains available on disk for execution and audit, but
is not repeatedly injected into the prompt. Evidence refers directly to attempt-relative paths;
there is no artifact-ID indirection and no repeated hash.

## Attempt Preparation

Attempt Preparation is a deterministic, non-modeling Python operation. For an initial stage
attempt it copies the currently accepted complete configuration into the new attempt. For a retry
it reads the parent attempt configuration and validated reviewer response, verifies the exact
target and old value, applies one absolute replacement, and writes the next complete
`effective-config.json` plus proposal-validation evidence.

Attempt Preparation does not run a physical model, infer a scientific decision, consume a retry by
itself, or maintain workflow state. The Lens Orchestrator and reviewer never merge the full JSON
configuration themselves. The final CLI spelling is an implementation detail; a conceptual form
is available through `lens-agent attempt prepare ...` for development. Expert stage execution
now prepares automatically; see [Stage preparation and recovery](stage-preparation-recovery.md)
for publication, process exclusion, and correctable pre-execution failures.

## Stage execution

Physical modeling continues to run only through `lens-agent stage`. Its new public input is the
lens result directory, stage, and attempt number, for example:

```bash
lens-agent stage \
  --lens-dir <input-lens> \
  --output-dir <lens-result> \
  --stage m1 \
  --attempt 2
```

The command resolves `attempts/m1/2/effective-config.json`, reads required accepted upstream
attempts through `accepted/`, loads the fixed Packaged Pipeline, and writes the current stage's
outputs only below `attempts/m1/2/`. It accepts neither `--pipeline` nor an arbitrary config path.

The normal workflow allocates a new attempt number for every scientific rerun. No additional
exclusive-write marker, content-integrity mechanism, or write-once enforcement is introduced in
this version.

## Candidate chain and promotion

Attempt 0 starts from the current Accepted Configuration Snapshot. Each valid retry proposal
applies to the immediately preceding eligible candidate, not the last accepted configuration:

```text
C0 accepted on entry to stage
  -> C1 / attempt 1 / rejected
  -> C2 / attempt 2 / rejected
  -> C3 / attempt 3 / accepted
```

Intermediate configurations remain candidate-only. On final acceptance, the whole C3
configuration becomes the Accepted Configuration Snapshot. If the stage terminates in human
review, C0 remains accepted and every rejected attempt is retained.

An attempt-local `decision.json` records the scientific decision but is not promotion authority.
After rereading the stage result and checking that the Hard Gate passed, `decision == accept`, the
configuration is schema-valid, required manifest paths exist and are readable, and the attempt is
the current candidate-chain end, the Orchestrator atomically writes `accepted/<stage>.json`.

The Accepted Stage Head contains only direct references, for example:

```json
{
  "schema_version": "accepted_stage_head.v1",
  "stage": "m1",
  "accepted_attempt": 2,
  "attempt_path": "../attempts/m1/2",
  "effective_config": "../attempts/m1/2/effective-config.json"
}
```

No hash matching is performed. If an accept decision exists but the head was not written before an
interruption, resume repeats the direct checks and completes promotion without rerunning the stage.

## Stage B specialization

Stage B retains its Persistent Arc Mask Expert, independent ten-retry budget, response correction
contract, and final scientific authority after the Hard Gate. It adopts the same attempt-local
configuration, candidate-chain, artifact, and promotion infrastructure.

A parameter refinement returns the same absolute one-setting proposal shape as other stages. A
component selection is not part of Effective Configuration. It is an attempt-local
`arc-component-selection.json` containing the complete dropped-component set and a direct
reference to the component catalog that defines those IDs. A mask-parameter refinement regenerates
the component catalog and invalidates the previous selection; a selection-only refinement keeps
the configuration unchanged. Parameter refinement and component selection remain mutually
exclusive within one retry. Downstream stages consume the accepted `feature_mask.fits`, not the
component IDs.

## Result layout and retention

New result roots use this layout:

```text
<lens-result>/
├── run-manifest.json
├── preflight/
├── attempts/
│   ├── a/0/
│   ├── b/0/
│   ├── m0/0/
│   ├── m1/0/
│   ├── m2/0/
│   └── m3/0/
└── accepted/
    ├── a.json
    ├── b.json
    ├── m0.json
    ├── m1.json
    ├── m2.json
    └── m3.json
```

Each attempt contains:

```text
attempts/<stage>/<N>/
├── effective-config.json
├── manifest.json
├── stage-result.json
├── artifacts/
├── diagnostics/
├── review-context.json       # reviewed stages only
├── review.json               # reviewed stages only
├── proposal-validation.json  # when applicable
└── decision.json
```

All stage-generated JSON, PNG, FITS, PKL, and other scientific outputs remain attempt-local.
Accepted and rejected attempts are retained and are not automatically pruned. Upstream accepted
artifacts are referenced rather than copied into every downstream attempt.

The Attempt Artifact Manifest records only an attempt-relative path, scientific role, and media
type, for example:

```json
{
  "path": "diagnostics/stage_m1_model.png",
  "role": "model_diagnostic",
  "media_type": "image/png"
}
```

It records no size, hash, or artifact ID. Reviews cite the same relative path directly.

## Historical results

The new Pipeline Release requires a new empty Lens Result Directory, but its Batch Output
Directory may contain other lenses. A historical lens result containing the old `pipeline.py`,
shared `cache/`, and `reviews/` layout remains read-only. The new workflow does not parse the old
Python file into configuration, reconstruct attempt lineage, manufacture Accepted Stage Heads,
migrate artifacts, resume that result, or prepare it for automatic rerun.

For a result with a valid Lens Run Manifest from any Pipeline Release, an explicit Full Lens Rerun
archives only that lens as `_archive/<lens_id>_old_<N>` and starts a fresh canonical result at
preflight. Archives never contribute inputs to the new run and are excluded from the Batch Summary;
other lenses in the batch are unchanged. Commands that write a current result reject `_archive/`
and all of its descendants. Resume retains its existing meaning and never archives the current
result.

## Implemented surface

1. Add strict configuration models and the explicit Tunable Catalog, plus generated/checked
   reviewer proposal schema and stage-scoped review-context renderer.
2. Add deterministic Attempt Preparation and attempt-local artifact manifests.
3. Change stage execution to load only the Packaged Pipeline and attempt-local configuration,
   resolve upstream inputs through Accepted Stage Heads, and write attempt-local outputs.
4. Add direct-reference promotion and resume logic.
5. Merge repair value selection into the Persistent Stage Reviewer contract; remove the active
   Model Tuner, candidate Python copies, unified diffs, and `--pipeline`.
6. Migrate Stage B parameter and selection refinements to the shared infrastructure while keeping
   its expert authority and retry budget.
7. Update golden contracts, orchestration instructions, CLI tests, configuration tests, attempt
   retention tests, Stage-B selection invalidation tests, and historical-root rejection tests.

## Pipeline Release determinations

The first Pipeline Release resolves the bounded implementation policy as follows:

- the explicit Tunable Catalog authorizes Stage A/M1/M2/M3 sampling budgets, M1 source-bbox
  padding, M2 adaptive-rho prior maximum, and four Stage-B mask parameters;
- numeric hard bounds and config-wide cross-field constraints form the initial safety envelope;
- public operations are `attempt prepare`, `stage --attempt`, `review context`, and
  `attempt promote`;
- attempt manifests enumerate every generated artifact path, role, and media type; and
- sampler settings are capped at 100,000 while retaining the cross-field `n_live <= n_eff`
  constraint, without introducing tuning ladders.

Changing any of these policy choices is an out-of-run Pipeline Release change.
# Current workflow note

The typed immutable configuration, Tunable Catalog, and attempt-local repair protocol in this
document remain active. Reviewer/orchestrator responsibilities are superseded by
[ADR 0018](../adr/0018-stage-experts-and-deterministic-adjudication.md): independent Stage Experts
own complete stage loops and stateless Python Stage Adjudication is the mandatory decision gate.
