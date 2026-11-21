---
name: lens-model-orchestrator
description: Run or resume a serial strong-lens batch by delegating complete stage loops to stage experts.
---

# Lens Model Orchestrator

Process requested lenses serially. The Batch Output Directory contains one current Lens Result
Directory per lens and a final `summary.csv`. This skill owns only batch order, the default per-lens
stage sequence and optional subhalo extension, expert delegation, terminal-evidence verification, rerun/resume routing, agent
temporary-file management, and final summary generation. It never reviews A, B, M0, M1, M2, or M3
evidence, proposes a retry, chooses a stage-local modeling or retry setting, writes stage review or decision JSON, or runs those
physical stages itself.

## Output language

Use clear Chinese by default in messages and reports shown to the user, including progress,
questions and options, corrections, and the final summary. Follow the user's explicit reply
language preference. Use concise scientific English for internal delegation and structured
scientific records. Preserve paths, identifiers, parameter names and values, mathematical
notation, and uncontrolled exception text exactly.

The Packaged Pipeline, input FITS, frozen input geometry, modeling mask, schemas, Tunable Catalog, thresholds, retry
budgets, and Pipeline Release are immutable during a Lens Run. Physical modeling is permitted only
through the exact absolute `GPU Stage Command`; every other pipeline operation uses the exact absolute
`Lens Agent Command`. A canonical `model` disposition permits the fixed single-deflector workflow
to run even when the preflight morphology is not unique; downstream Stage Experts route unresolved
structural failures to Human Review.

## Routine decisions and Human Review

Apply the user's explicit rules and established defaults within their stated lens or batch scope.
When several scientifically safe options are available within that scope, choose the one you
recommend from the evidence, record the reason in the normal stage evidence, and continue. Ask
only when a missing decision materially changes the scientific interpretation or the authorized
scope and the current artifacts and allowed repairs cannot resolve it.

Pass applicable user rules to each Stage Expert with the delegation so the expert can apply
them during review. Use the existing review and retry paths to test a safe recommendation.
Record local scientific uncertainty through the stage's applicable warning or finding fields
when the result meets the acceptance criteria. Keep any required command approval or explicit
authorization for scope changes with the user. In a batch, report the exact blocker for the
affected lens and continue any independent lenses already authorized to proceed.
When user input is necessary, explain the concrete blocker, your recommendation, and its
consequence in one request. Reuse the user's answer within the same scope unless the evidence
or required authorization changes.

## Task name in TinyLens Web

When a user gives a modeling instruction in TinyLens Web and `tinylens_ui_report` is available,
choose a short display name as soon as the target is clear. Use the object's familiar survey
identifier, such as `SDSSJ0946`, if supported by the user's input or the input inventory. For a
batch, use a concise name that identifies the whole set. Use a single line of at most 40 characters
and report it once for the task, before the first preflight or batch preview where possible.
If the target is still ambiguous, report the name once the user has clarified it.

Send this structured output with `tinylens_ui_report`, substituting the chosen title:

```json
{"kind":"note","stage":"task_name","status":"suggested","title":"SDSSJ0946","message":"Workbench task name"}
```

Continue the existing modeling workflow after the report. The workbench gives a manually saved
name priority.

## Command defaults for a fresh Web run

For a fresh run requested directly in the TinyLens Web workbench, locate the deployment's Python
when the Lens Result Directory has no existing run evidence.
The operator may publish the absolute interpreter in `workspace/releases/default-python` under
the resolved Repository Root as a single non-empty line. When that file exists, read the path
without evaluating the file as shell code. Otherwise use the bridge's `TINYLENS_PIPELINE_PYTHON`
setting. Resolve a configured command name with `command -v`. Verify the resulting path is absolute
and executable. Keep the interpreter path used to enter its environment, including a virtual
environment's `bin/python` path.

Verify that `scripts/run_lens_stage_on_idle_gpu.sh` is executable under the resolved Repository
Root. When the user supplied neither command, use `<python> -m lens_agent.cli` for the Lens Agent Command and
`<absolute runner> --python <python>` for the GPU Stage Command. Quote each path when assembling
the commands and pass these exact commands to every delegated expert. If either default cannot be
verified, ask for the explicit commands. Use the exact commands supplied for a resumed run or
in a delegated batch. Preserve any explicitly supplied command and ask for any missing counterpart.

If a fresh Web run supplies its own commands, check the Pipeline Release and initial M0 source
grid of the selected Python environments against the deployment before preflight. If a command
points to an older release and the user has not explicitly selected that release, report the
discrepancy and ask for corrected commands before writing run evidence.

## Agent temporary files

Before the first agent-authored temporary write, resolve the absolute repository root supplied as
`Repository Root`. For direct interactive invocation without that field, locate the repository
containing this skill and verify `.codex/skills/lens-model-orchestrator/SKILL.md` exists
there. In TinyLensWeb this directory is `pipeline/`, inside the enclosing Git repository;
`git rev-parse --show-toplevel` alone identifies the enclosing Web repository, not this workflow root. Use only `<repo>/tmp/` for agent
responses, drafts, and auxiliary files during this Lens Run. This is an agent instruction, not a new
CLI path check. Development files and third-party caches are outside its scope; pipeline-owned
temporary files for atomic replacement remain beside their final targets.

The orchestrator owns creation and final cleanup. Create `<repo>/tmp/` if needed, then use
`mktemp -d "<repo>/tmp/lens-session.XXXXXXXXXX"` with the resolved absolute root substituted.
Record the returned absolute session path. Allocate `<session>/<lens_id>/preflight/` and
`<session>/<lens_id>/stage-<stage>/` as needed, with lower-case stage identifiers. Before creating or
using these paths, verify they remain inside the repository's real `tmp/` directory and outside the
Lens Result Directory; do not redirect them through symbolic links. On a path conflict or creation
failure, report the error and stop dependent work without falling back to another location.
Ordinary filesystem tools are permitted for this temporary-file management.

Pass each Stage Expert its assigned absolute `Agent Temporary Directory`. A replacement expert
for the same lens × stage in this session uses that same directory; response filenames include the
attempt number. Every new orchestrator session, including resume, uses fresh temporary space. A
Full Lens Rerun also allocates fresh unique space for that lens, even within the same session.
Restore progress only from canonical results; old temporary files are neither resume evidence nor
sources for assembling partial preflight votes. Leave historical temporary directories untouched.

After verifying the requested endpoint (M3 by default; subhalo acceptance, no-candidate, or
Human Review when subhalo is requested), wait for
all experts and commands for that lens to finish, then delete its remaining temporary responses,
drafts, and auxiliary files in this session. Before deletion, resolve the exact owned lens path and
verify no active task uses it. Delete only that lens's temporary subtree; remove an empty session
directory with `rmdir`. Preserve the repository `tmp/` root and other lenses' or sessions' files.
On operational failure, retain remaining temporary files and report their absolute directory.
If normal cleanup fails, report the residual path without changing canonical scientific decisions
or rerunning computation. Report retained paths in the terminal response; do not automatically
expire old directories.

## Full Lens Rerun and resume

An explicit request to rerun from M0 onward while retaining an accepted A and B permits a new
Lens Run with verified A/B evidence from a compatible earlier Pipeline Release. Wait until the
source run has no active expert, scientific review, or command for this lens. Use the current
deployment's interpreter and runner. Choose a fresh Lens Result Directory under a different batch
directory with the same lens ID, then run:

```text
<Lens Agent Command> rerun from-m0 --source-run <current-source-result> --output-dir <fresh-result>
```

Verify the new manifest and the inheritance record. The original run stays at its original path.
The inherited stages retain their original acceptance, decisions, and input geometry. Do not
repeat preflight, A, or B, and do not register them as newly executed or reapproved. Start at M0/0
on the new release's initial source grid and follow the normal expert reviews, retry rules, and
stage-reporting procedure through the requested endpoint. Use only the new run ID for new results.
If evidence validation fails, report the specific problem and wait for the user to choose how
to proceed.

An explicit request to rerun **only Stage B** authorizes a Stage B-only restart. Resolve the
existing Lens Result Directory, verify that A is accepted, B's latest attempt has terminal
Human Review, and B and downstream stages have no accepted results or downstream attempts.
Preserve the existing run, Stage A head, and every old B record. Delegate a fresh Stage B Expert
with the explicit restart authorization and stop at the new B decision. Do not start M0 for
this request. Repeat the ordinary scope and terminal-evidence checks for the new B attempt.

Treat explicit “重新分析”, “重跑”, “从头开始”, or unambiguous equivalents as a Full Lens Rerun.
Wait for any active expert or command for that lens to finish, then run:

```text
<Lens Agent Command> rerun prepare --output-dir <lens-result>
```

This archives only that lens as `_archive/<lens_id>_old_<N>` and creates no replacement itself. The
normal workflow then starts a fresh current Lens Result Directory at preflight. Never delete, write,
or resume an Archived Lens Run. Never reuse its masks, attempts, reviews, decisions, Accepted Stage
Heads, or retry budget.

Treat explicit “继续” or “恢复” as Lens Resume. Reuse the current Accepted Stage Heads and never
rerun an accepted stage. If user language does not distinguish rerun from resume while a current
result exists, ask before changing either path. A Lens Run from another Pipeline Release is
read-only under the current workflow and requires a Full Lens Rerun for fresh results.

Reject historical roots containing the old `pipeline.py`, shared `cache/`, or `reviews/` layout.
Leave their evidence untouched and request a new Lens Result Directory. Do not run two workflows
for the same lens concurrently.

## One lens

### Preflight

Before the first preflight of a fresh run, establish the calibrated input conventions from reliable
data metadata or an explicit user description: positive `pixel_scale_arcsec`, and
`input_x_direction` / `input_y_direction`, each `increasing` or `decreasing`. The directions describe
how physical x/y change with the original FITS column/row indices. The documented legacy defaults
are `0.1`, `increasing`, `increasing`; do not assume those defaults for data known to have a different
calibration. If the evidence is ambiguous, ask the user before starting dependent work. This
run-initialization declaration is not a choice of a sampled physical parameter or a stage retry.

Pass a non-default declaration to `preflight` with `--pixel-scale-arcsec`, `--input-x-direction`,
and `--input-y-direction`. Record its supporting metadata or user statement with the optional
`--geometry-evidence` text. Do not infer a full coordinate transformation from one FITS keyword:
the declared input must be a square image with aligned square pixels, and its PSF and optional
colour bands must share the same sampling and axis directions. Each reflected PSF axis must have
odd length to preserve the convolution centre. General WCS rotation/shear, non-square images,
unequal axis scales, PSF resampling, or band registration is outside this interface and requires a
separate user decision.

The pipeline freezes the declaration in the run manifest and preflight record, reflects all
aligned input planes and the PSF together, and supplies the same geometry to all stages. Do not
pre-flip or resample the FITS to compensate for a declared direction. On resume, use the recorded
geometry and omit geometry overrides; an explicit mismatch must stop rather than overwrite any
artifact. A requested geometry correction requires a Full Lens Rerun from fresh preflight, with
no reuse of old masks, attempts, reviews, or Accepted Stage Heads. A geometry mismatch is an
operational prerequisite failure, not a scientific retry or permission to edit configuration files.

On a fresh run, `preflight` uses a matching local Euclid DR1 ECLIPSE `dataset/` when available.
It checks the prepared input layout, a configured `LENS_AGENT_EUCLID_RELEASE_ROOT`, and the
source cutout in the input provenance. When the user gives a separate dataset directory, pass
`--euclid-dataset-dir <dataset>` on the first preflight. The directory contains the matching
`<lens_id>.fits` and `segmentation/artefact_binary.fits`. Preflight verifies the VIS pixels and
freezes the mask source. With `Euclid DR1 contamination mask` in the right panel, inspectors
review modelability and estimate the Einstein radius. Their `contaminant_ids` and the synthesis
list are empty and `mask` uses the official pixels. With no release mask, use the usual
contaminant-ID votes. Report invalid release inputs to the user.

1. If canonical `preflight/inspector.json` already exists, do not repeat preflight inspection; read
   it and continue or stop from its disposition. Otherwise run `<Lens Agent Command> preflight --lens-dir
   <input>/<lens_id> --output-dir <lens-result>`. If a prior session left only votes or synthesis,
   rerun all three inspections and synthesis; never mix or reuse a partial set.
2. Start three independent `system_inspector` agents in parallel. Give each agent only the exact
   `lens_id` and the packet's same `inspector_prompt_png`, never the separate `human_audit_png`.
   Each inspector cannot see either of the other responses. Save each strict response as
   `<session>/<lens_id>/preflight/vote-<index>-response.json` for indices 0, 1, and 2.
   Return a response-contract error to the inspector that produced it at most twice; a third invalid
   response from any inspector is an operational stop. Do not persist any vote until all three
   responses are valid.
3. Register the complete vote set together with `<Lens Agent Command> inspector votes --output-dir
   <lens-result> --response <vote-0-response> --response <vote-1-response> --response
   <vote-2-response>`. If validation identifies one response, return that error to the same
   inspector within its existing correction allowance, then retry registration with all three
   responses. The command writes only `preflight/inspector-votes/0.json`, `1.json`, and `2.json`.
   Keep all three temporary responses during validation and corrections; delete them only after
   verifying the complete canonical vote set was successfully registered.
4. After successful vote registration, close all three System Inspectors. Start one
   `preflight_synthesis_expert`. Give it only the exact `lens_id` and the three canonical vote paths;
   never give it either preflight image, the segmentation FITS, or other files. Save its strict
   response as `<session>/<lens_id>/preflight/synthesis-response.json`.
5. Run `<Lens Agent Command> inspector synthesis --output-dir <lens-result> --response
   <synthesis-response>`. Return any contract or majority-validation error to the same synthesis
   expert at most twice; a third invalid response is an operational stop. Validation rejects but
   never calculates or rewrites the expert response. Only `preflight/synthesis.json` is registered
   by this command. Keep the temporary response during corrections and delete it only after
   verifying successful canonical synthesis registration.
6. Run `<Lens Agent Command> mask --output-dir <lens-result> --inspection
   <lens-result>/preflight/synthesis.json`. Only the canonical `preflight/inspector.json` written by
   `mask` and its Modeling Mask are authoritative downstream; votes and synthesis remain audit
   evidence.
7. If the canonical disposition is `human_review`, run no physical stage and finish this lens.

### Fixed stage sequence

Progress in exactly this order:

| Stage | Owner |
|---|---|
| A | one persistent `stage_a_expert` for this `lens × A` |
| B | one persistent `stage_b_expert` for this `lens × B` |
| M0 | one persistent `stage_m0_expert` for this `lens × M0` |
| M1 | one persistent `stage_m1_expert` for this `lens × M1` |
| M2 | one persistent `stage_m2_expert` for this `lens × M2` |
| M3 | one persistent `stage_m3_expert` for this `lens × M3` |

For each expert-owned stage, provide the input Lens Directory, Lens Result Directory, assigned
stage, its absolute `Agent Temporary Directory`, the exact absolute `Lens Agent Command`, the exact
absolute `GPU Stage Command`, and instruction to run or resume its complete loop. The expert's shared operational manual and
stage-specific instructions own every prepare, execute, review, adjudicate, retry, promote, and
resume detail. Keep the same expert session across eligible retries and response corrections.

An expert turn is not proof of completion. After it reports terminal status, reread filesystem
evidence:

- Continue only when `accepted/<stage>.json` exists and names that stage's current sealed attempt.
- Stop the lens when the latest canonical `decision.json` says `human_review`; preserve its exact
  reason and reason kind.
- If the expert reports `preparation_blocked`, preserve its reason and operation-log location,
  pause this lens, and report that it remains incomplete and can continue after correction.
  This is not terminal Human Review. Retain its expert temporary files; resume the same attempt
  after the prerequisite changes. Do not send unchanged preparation errors back for adjudication.
- If neither terminal artifact exists and preparation is not blocked, return the incomplete
  evidence to the same expert. If that
  session is lost, create one replacement for the same `lens × stage`; it resumes from the files
  without rerunning a completed attempt or consuming a retry.

Close a stage expert after its Accepted Stage Head or terminal Human Review has been verified,
or after recording its preparation-blocked handoff for later resume.
Never reuse an expert for another lens or stage. If the subagent limit prevents delegation, close
completed terminal experts from this batch and retry once; if it still fails, stop with
`orchestration_cleanup_failed` and preserve the lens for resume.

## Optional subhalo search

When the user requests a subhalo search, preserve accepted A–M3 and delegate one persistent
`stage_subhalo_expert` after M3. Give it the same commands, input/output directories and its own
`stage-subhalo/` Agent Temporary Directory. Its complete workflow is in
[Stage-subhalo](references/stage-subhalo.md). The orchestrator does not choose the candidate or
review its scientific evidence. If the named role is not yet loaded in the current session, use a
fresh default agent with the complete `.codex/agents/stage-subhalo-expert.toml` instructions and the
same ownership; do not fall back to running the physical stage in the orchestrator.

Verify `accepted/subhalo.json` or a canonical subhalo Human Review as for other stages. The additional
normal terminal outcome is `attempts/subhalo/candidate.json` with `status: no_candidate`; verify
there is no physical subhalo execution before reporting it. An accepted non-significant search is
complete. Do not stop at accepted M3, generate a final search summary, or clean up the expert's
working files while a requested subhalo stage remains incomplete. No subhalo request means the
original fixed stage sequence and completion conditions remain unchanged.

## Finish

After a lens has an accepted M3 and has reached the requested endpoint, prepare `comment-draft.json`
in the Agent Temporary Directory. Write a UTF-8 JSON object whose keys are `preflight`, `a`, `b`,
`m0`, `m1`, `m2`, and `m3`. Each value is one or two short sentences in the user's reply language,
on one line. For each stage, state its principal result and assess its quality or most relevant
limitation. Use the canonical `preflight/inspector.json` for preflight and the accepted attempt's
`stage-result.json`, `review.json`, and `decision.json` for the physical stages. For a run with
inherited preflight and A/B, use the original accepted evidence identified by the inheritance record
and describe those results as inherited. Preserve any material warning or uncertainty recorded in
the review. This is a summary of the saved evidence and decisions.

Reuse an already registered `modeling-comment.json` when resuming. For a new comment, run
`<Lens Agent Command> modeling-comment --output-dir <lens-result> --comment-file <draft>` and
reread the registered file. When the TinyLens UI report tool is available, report it as an
`artifact` for stage `m3`, with the accepted M3 attempt and the same run identity.

After every requested lens reaches its requested endpoint or Human Review, run:

```text
<Lens Agent Command> summary --output-dir <batch-output>
```

Return `summary.csv` as a Markdown table with lens ID, terminal status, diagnostic reason, M3 mass
posterior summaries, and result directory. For requested subhalo searches also include subhalo
status, both evidence values, their difference, residual improvement, and SIS posterior intervals. `_archive/` remains excluded.
If preparation remains blocked, report the unfinished lens and required correction instead of
claiming the batch is complete or generating a terminal summary for that unfinished batch.
