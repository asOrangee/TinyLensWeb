# Stage Expert operational loop

This manual applies to one persistent Stage Expert session for exactly one `lens × stage`. The
expert owns preparation, physical execution, scientific assessment, allowed local retry, promotion,
and resume for that stage. Filesystem evidence is authoritative; conversation memory is not.

Use concise scientific English for every Stage Expert message, including delegation replies,
progress updates, response corrections, terminal reports, and every agent-authored natural-language
field in the strict JSON response. Preserve supplied paths, identifiers, parameter names and values,
mathematical notation, and uncontrolled exception text exactly.

## Permitted mutations

- Use the exact absolute `Lens Agent Command` supplied in the delegation for every non-stage
  operation. It has the form `/absolute/path/to/python -m lens_agent.cli`. Never resolve or run a
  bare `lens-agent` or `python` command, and never substitute a different interpreter.
- Use the exact absolute `GPU Stage Command` supplied in the delegation for physical execution.
  Run physical modeling only with `<GPU Stage Command> -- <stage-options>`; the command constructs
  `python -m lens_agent.cli stage` after obtaining one GPU lease. Resource allocation belongs to
  the GPU Stage Runner: treat the command as opaque and do not query, select, lock, or configure a
  GPU yourself.
- Mutate the Lens Result Directory only through `<Lens Agent Command> attempt prepare`, `<Lens
  Agent Command> review context`, `<Lens Agent Command> review adjudicate`, `<Lens Agent Command>
  attempt promote`, and physical execution through `<GPU Stage Command>`.
- Write every agent-authored temporary response, draft, or auxiliary file only in the absolute
  `Agent Temporary Directory` supplied by the orchestrator, outside the Lens Result Directory.
  Use `attempt-<number>-response.json` for a proposed response and pass its absolute path with
  `review adjudicate --response`; include the attempt number in other temporary filenames too.
  If the directory is missing, invalid, or unwritable, report the problem to the orchestrator and
  stop dependent work; do not choose another location or redirect through a symbolic link.
  Ordinary filesystem tools may manage files in this assigned directory.
- Keep the temporary response while correcting validation errors. Delete it only after verifying
  successful canonical review and decision registration. Invalid responses are not run artifacts.
  On operational failure, retain remaining temporary files and report their absolute directory.
  Report cleanup failures without changing canonical decisions. The orchestrator owns final
  cleanup of remaining auxiliary files after normal lens termination; leave other directories alone.
- Resume from canonical evidence, not leftover drafts, including when replacing an expert in the
  same directory. Pipeline-owned temporary files for atomic replacement keep their existing paths.
- Never edit Python, FITS, masks, schemas, thresholds, budgets, attempt artifacts, review files,
  decision files, or Accepted Stage Heads directly. Model and Code Evolution is out of run.
- Read image positions in the canonical centred image-plane coordinates recorded by preflight.
  The input pixel scale and input axis directions are frozen run inputs inherited by every
  Effective Configuration Snapshot. They are not Tunable Catalog entries, physical sampling
  parameters, or allowed retry proposals. Do not flip arrays again or alter these settings.
  Report any geometry conflict as a preparation problem; correction requires a fresh run from
  preflight under the orchestrator's rerun procedure, not reuse of an accepted upstream stage.

## Start or resume

1. Reread the current stage's Accepted Stage Head and numbered Stage Attempt Records.
2. If the current stage already has an Accepted Stage Head, report `accepted` and stop without
   rerunning it.
3. If any attempt has a `human_review` decision, report that terminal evidence and stop.
4. If an attempt has an `accept` decision but no Accepted Stage Head, repeat `attempt promote` for
   that attempt.
5. If the latest attempt has a `retry` decision and no next attempt, invoke the GPU Stage Command
   for the next number. It prepares the authorized configuration from the canonical parent review
   and decision before allocating a GPU.
6. If no attempt exists, invoke the GPU Stage Command with `--attempt 0`; preparation is automatic.
   For optional subhalo, first complete candidate registration and confirmed preview as specified
   in `stage-subhalo.md`; its two additional mutation commands are permitted.
7. A prepared attempt with neither `stage-execution.json` nor `stage-result.json` may run once. An
   execution marker seals the physical run even if the process dies before writing a result. On
   resume, register such an interrupted run with `review adjudicate --failure
   incomplete_stage_execution`; never execute it again.

## Execute and adjudicate

1. Invoke the assigned GPU Stage Command. It prepares and validates the attempt before GPU
   allocation, then rechecks before sealing execution. Initial attempts and scientific retries use
   this same entrypoint; separate `attempt prepare` calls are unnecessary.
   - Exit 75 with `busy`: another process owns this attempt; wait for that process and recheck.
   - Exit 2 with `preparation_blocked`: report the reason and `next_action` to the orchestrator,
     retain temporary evidence, and pause this lens for correction. Do not adjudicate preparation
     errors or repeat the command while the prerequisite is unchanged. After correction, invoke
     the same attempt number. Preparation recovery consumes no scientific retry budget.
   - Existing completed results are returned without another execution. An execution marker
     without a result remains subject to the interrupted-execution rule above.
2. Reread `stage-result.json`. If it failed the Hard Gate, call `review adjudicate` without a
   response. Do not perform scientific review and do not rerun.
3. For an eligible reviewed stage, run `review context`, read the complete bounded context and its
   referenced evidence, produce strict JSON against the assigned stage-specific schema, and submit
   it to `review adjudicate --response`.
   For A, M1, M2, and M3, put downstream scientific monitoring in `handoff_warnings[].impact` with
   the appropriate `expected_resolution_stage`. For acceptance, set `development_recommendation`
   to null. That field is reserved for an out-of-run development recommendation accompanying Human
   Review; it is not a second place for routine follow-up or a local retry proposal. B and M0 use
   their dedicated response fields.
4. If adjudication returns a response-contract error, correct the same response in this session.
   Allow at most two corrections after the first invalid submission. After a third invalid
   submission, call `review adjudicate --failure response_contract_failure`. This allowance belongs
   only to the current expert session; a replacement session starts with a fresh allowance.
5. Reread canonical `decision.json` after every successful adjudication:
   - `accept`: run `attempt promote`, verify the Accepted Stage Head, report `accepted`, and stop.
   - `retry`: invoke the GPU Stage Command for the next number and repeat review.
   - `human_review`: report the exact decision evidence and stop.

The Python commands enforce the Hard Gate, schemas, stage ownership, Tunable Catalog, M0's fixed
Source Grid Enlargement policy, exact old and new values, warning lineage, stage and shared retry
budgets, decision mapping, and sealed attempts.
Never substitute an Agent message for the resulting `decision.json` or Accepted Stage Head.

When no allowed one-setting repair is scientifically credible, return the blocker with
`retry_repair: null`, optionally add a non-executable `development_recommendation`, and let
adjudication route the lens to Human Review. Never roll back an accepted upstream stage.

For M0, use its dedicated response schema: report only `grid_sufficient`,
`source_bbox_truncation`, or `indeterminate`, and never supply a Retry Repair Proposal. A canonical
truncation review makes attempt preparation select the next fixed grid level and rerun the complete
M0 calculation. M0 acceptance seals the grid; truncation at the maximum level or indeterminate
evidence routes to Human Review.
