# One-Lens-Per-Session Batch Runner

`run_lens_batch.sh` processes a batch of strong-lens systems serially. It starts a fresh Codex
session for each lens and instructs `$lens-model-orchestrator` to handle only that lens. This keeps
the conversation context bounded while retaining filesystem-based recovery between sessions.

The script controls only batch order, Codex sessions, and operational logs. It does not change the
physical model, input FITS files, modeling masks, thresholds, Pipeline Release, or scientific retry
budgets. Physical modeling continues to run through `lens_agent.cli stage`.

## Defaults

With no command-line options, the script uses:

| Setting | Default |
|---|---|
| Input directory | `dataset/` |
| Output directory | `output/euclid_test/` |
| Number of lenses | First 10 lens directories in lexical order |
| Conda environment | Active `CONDA_PREFIX`, `TINYLENS_CONDA_ENV`, or `--conda-env` |
| Automatic recovery | Up to 2 additional sessions after the first session |

The first 10 lenses are selected using stable `LC_ALL=C` lexical ordering, not creation or
modification time.

## 1. Preview the batch safely

From the repository root, run:

```bash
./scripts/run_lens_batch.sh --dry-run
```

This command only prints the selected lenses and their current states. It does not create
directories, invoke Codex, or run physical modeling. Common states are:

- `not_started`: no result directory exists for this lens.
- `incomplete`: recoverable intermediate evidence exists, but the lens has no terminal result.
- `success`: an accepted Stage M3 result exists.
- `human_review`: the workflow has formally routed the lens to human review.
- `invalid_evidence`: existing files cannot be treated as valid recovery evidence.

Run `--dry-run` before a production batch to confirm that the selected lens IDs and output directory
are correct.

## 2. Start the batch

After checking the preview, run:

```bash
./scripts/run_lens_batch.sh
```

The batch preview does not import JAX or inspect GPU hardware. During execution, every physical
stage is launched through `run_lens_stage_on_idle_gpu.sh`, which validates the requested Python
environment under an acquired single-GPU lease before the stage writes execution evidence.

This command writes under `output/euclid_test/`, invokes Codex, and may start long-running GPU lens
modeling. It runs Codex with `danger-full-access` because the narrower Codex workspace sandbox does
not expose the GPU device. Therefore, run this script only in this trusted repository and with its
reviewed agent instructions. It runs in the foreground, so keep the terminal and compute
environment available.

For each lens, the script applies these rules:

1. `success` or `human_review`: skip the lens without recomputing it.
2. `not_started`: start a new single-lens Lens Run.
3. `incomplete`: start a fresh Codex session and resume from canonical filesystem evidence.
4. If the session exits without a terminal result, start at most two additional recovery sessions.
5. If the lens is still incomplete after the recovery limit, record its state and continue with the
   next lens.

The script never initiates a Full Lens Rerun, never calls `rerun prepare`, and never archives or
deletes an existing result. It resumes existing work; it does not restart that work from preflight.

### GPU allocation

On this server, GPU inventory queries use the compatible NVML library under
`$HOME/.local/lib/tinylens-gpu-query/595.84`. The stage runner applies this library path
only to `nvidia-smi`; it preserves the modeling process's existing `LD_LIBRARY_PATH`.
Set `GPU_QUERY_LD_LIBRARY_PATH` to another compatibility-library directory when needed,
or set it to an empty string to use the system library. If the directory is absent,
the runner uses the normal system query. Keep the library version matched to the
loaded kernel driver after future driver changes.

The original working query was supplied with
`LD_LIBRARY_PATH=/tmp/gpu-query-59584-review-20260925`; the same NVML library was copied
to the user-owned persistent directory above so temporary-file cleanup does not
remove it.

Each A, B, M0, M1, M2, or M3 process receives one GPU for only its physical execution lifetime.
The runner considers a GPU idle when `memory.used <= 2000 MiB` and `utilization.gpu <= 10%`, chooses
the candidate with the lowest memory use, utilization, then numeric index, and checks again every
five seconds when all candidates are busy. Override those defaults with
`MAX_MEMORY_USED_MB`, `MAX_GPU_UTILIZATION`, and `GPU_POLL_INTERVAL_SECONDS`.
These overrides affect only resource allocation and operational-failure risk; they do not change
the physical model and are not recorded in stage evidence.

The runner sets `CUDA_DEVICE_ORDER=PCI_BUS_ID` and `CUDA_VISIBLE_DEVICES` before Python imports JAX.
It does not modify JAX's memory-preallocation configuration. If the caller already supplied one
numeric `CUDA_VISIBLE_DEVICES` value, that upstream assignment is used without scanning the host;
multi-device or nonnumeric assignments are rejected.

Locks under `${TMPDIR:-/tmp}/agentic-lens-gpu-locks-$UID` prevent this Unix user's cooperating
runner processes from selecting the same device. `nvidia-smi` also avoids GPUs already visibly
busy, but these locks cannot provide atomic exclusion against another user or a program that does
not use this runner. Use Slurm or another system scheduler when cross-user allocation must be
authoritative. A failed GPU query stops before Python starts and does not consume a scientific
retry.

## 3. Inspect results and logs

The main output files and directories are:

```text
output/euclid_test/
  <lens_id>/                         Scientific artifacts and canonical evidence for one lens
  summary.csv                        Scientific summary for the batch
  batch-status.tsv                   Operational batch status; not a scientific result
  .orchestrator-logs/
    <UTC-timestamp_process-id>/
      batch-status.tsv               Complete status record for this invocation
      <lens_id>.session-1.log         Codex session log
      <lens_id>.session-1.last-message.txt
  .lens-batch.lock                   Prevents concurrent runners for the same output directory
```

The script generates `summary.csv` only after every current lens result in the output directory has
reached `success` or formal `human_review`. It runs:

```bash
python -m lens_agent.cli summary --output-dir output/euclid_test
```

If any lens remains incomplete, the script does not refresh an existing `summary.csv`. Consult the
terminal output, `batch-status.tsv`, and the corresponding session log instead. Do not assume that
an older `summary.csv` describes the latest incomplete invocation.

## 4. Customize the batch

For example, to process the first 20 lexically sorted lenses in another directory:

```bash
./scripts/run_lens_batch.sh \
  --input-dir /path/to/dataset \
  --output-dir /path/to/output \
  --limit 20 \
  --conda-env /path/to/conda/env \
  --max-resumes 2
```

These paths are included in each single-lens Codex instruction. The output directory is also added
explicitly to the locations that Codex may write.

Display all available options:

```bash
./scripts/run_lens_batch.sh --help
```

If `codex` is not on `PATH`, provide its full path:

```bash
CODEX_BIN=/path/to/codex ./scripts/run_lens_batch.sh --dry-run
```

## 5. Stop and resume safely

Press `Ctrl+C` to stop the runner. The script sends a termination signal to the current Codex
session and preserves evidence already written for the lens. Run the same command again to resume
according to the rules above.

Do not run two scripts against the same output directory. The batch lock also rejects this case.

Do not manually delete or overwrite `attempts/`, `accepted/`, `decision.json`, `run-manifest.json`,
or input FITS files. If a physical stage started but did not produce a complete result, the recovery
workflow uses canonical evidence to determine whether human review is required. It does not
overwrite and re-execute the same attempt.

## Exit status

| Code | Meaning |
|---|---|
| `0` | Every relevant lens reached a terminal state and `summary.csv` was generated successfully. |
| `1` | At least one lens remains incomplete; evidence and logs were preserved and `summary.csv` was not refreshed. |
| `2` | Argument, dependency, directory, or batch-lock validation failed before normal batch execution. |
| `130` | The user interrupted the batch. |

All Lens Orchestrator, System Inspector, and Stage Expert messages produced during a Lens Run must
remain in English, as required by the repository policy.
