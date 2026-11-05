#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

INPUT_DIR="$REPO_DIR/dataset"
OUTPUT_DIR="$REPO_DIR/output/euclid_test"
CONDA_ENV="${TINYLENS_CONDA_ENV:-${CONDA_PREFIX:-}}"
LIMIT=10
MAX_RESUMES=2
DRY_RUN=0

usage() {
    printf '%s\n' \
        "Usage: $(basename -- "$0") [OPTIONS]" \
        "" \
        "Run one isolated Codex lens-model-orchestrator session per lens." \
        "" \
        "Options:" \
        "  --input-dir PATH     Input directory containing lens directories" \
        "                       (default: $INPUT_DIR)" \
        "  --output-dir PATH    Batch output directory" \
        "                       (default: $OUTPUT_DIR)" \
        "  --conda-env PATH     Conda environment prefix" \
        "                       (default: $CONDA_ENV)" \
        "  --limit N            Number of lexically sorted lenses to process" \
        "                       (default: $LIMIT)" \
        "  --max-resumes N      Fresh recovery sessions after the first session" \
        "                       (default: $MAX_RESUMES)" \
        "  --dry-run            Print selected lenses and current states only" \
        "  -h, --help           Show this help" \
        "" \
        "Environment:" \
        "  CODEX_BIN                    Override the Codex CLI executable" \
        "  MAX_MEMORY_USED_MB           Idle-GPU memory-used threshold (default: 2000 MiB)" \
        "  MAX_GPU_UTILIZATION          Idle-GPU utilization threshold (default: 10)" \
        "  GPU_POLL_INTERVAL_SECONDS    Seconds between GPU checks (default: 5)"
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 2
}

require_value() {
    if (($# < 2)) || [[ -z $2 ]]; then
        die "$1 requires a value"
    fi
}

while (($#)); do
    case "$1" in
        --input-dir)
            require_value "$@"
            INPUT_DIR=$2
            shift 2
            ;;
        --output-dir)
            require_value "$@"
            OUTPUT_DIR=$2
            shift 2
            ;;
        --conda-env)
            require_value "$@"
            CONDA_ENV=$2
            shift 2
            ;;
        --limit)
            require_value "$@"
            LIMIT=$2
            shift 2
            ;;
        --max-resumes)
            require_value "$@"
            MAX_RESUMES=$2
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

[[ $LIMIT =~ ^[1-9][0-9]*$ ]] || die "--limit must be a positive integer"
[[ $MAX_RESUMES =~ ^[0-9]+$ ]] || die "--max-resumes must be a non-negative integer"

INPUT_DIR=$(realpath -e -- "$INPUT_DIR") || die "input directory does not exist: $INPUT_DIR"
[[ -d $INPUT_DIR ]] || die "input path is not a directory: $INPUT_DIR"
OUTPUT_DIR=$(realpath -m -- "$OUTPUT_DIR")
[[ -n $CONDA_ENV ]] || die "Activate your environment, set TINYLENS_CONDA_ENV, or pass --conda-env"
CONDA_ENV=$(realpath -e -- "$CONDA_ENV") || die "conda environment does not exist: $CONDA_ENV"
CONDA_PYTHON="$CONDA_ENV/bin/python"
[[ -x $CONDA_PYTHON ]] || die "conda environment has no executable Python: $CONDA_PYTHON"
GPU_STAGE_RUNNER=$(realpath -e -- "$SCRIPT_DIR/run_lens_stage_on_idle_gpu.sh") || \
    die "GPU Stage Runner does not exist"
[[ -x $GPU_STAGE_RUNNER ]] || die "GPU Stage Runner is not executable: $GPU_STAGE_RUNNER"

CODEX_BIN=${CODEX_BIN:-$(command -v codex || true)}
[[ -n $CODEX_BIN && -x $CODEX_BIN ]] || die "Codex CLI was not found; set CODEX_BIN explicitly"
CODEX_BIN=$(realpath -e -- "$CODEX_BIN")
command -v flock >/dev/null 2>&1 || die "flock is required for batch locking"
command -v setsid >/dev/null 2>&1 || die "setsid is required for signal-safe process control"

mapfile -t LENS_IDS < <(
    find "$INPUT_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
        | LC_ALL=C sort \
        | sed -n "1,${LIMIT}p"
)

if ((${#LENS_IDS[@]} < LIMIT)); then
    die "requested $LIMIT lenses, but only ${#LENS_IDS[@]} lens directories exist in $INPUT_DIR"
fi

lens_state() {
    local lens_result=$1
    "$CONDA_PYTHON" - "$lens_result" <<'PY'
import json
import sys
from pathlib import Path

lens_dir = Path(sys.argv[1])
if not lens_dir.exists():
    print("not_started")
    raise SystemExit(0)
if not lens_dir.is_dir():
    print("invalid_evidence")
    raise SystemExit(0)

def read_json(path: Path):
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None

head_path = lens_dir / "accepted" / "m3.json"
if head_path.is_file():
    head = read_json(head_path)
    if not isinstance(head, dict) or head.get("stage") != "m3":
        print("invalid_evidence")
        raise SystemExit(0)
    attempt_path = head.get("attempt_path")
    if not isinstance(attempt_path, str):
        print("invalid_evidence")
        raise SystemExit(0)
    attempt_dir = (head_path.parent / attempt_path).resolve()
    try:
        attempt_dir.relative_to(lens_dir.resolve())
    except ValueError:
        print("invalid_evidence")
        raise SystemExit(0)
    decision = read_json(attempt_dir / "decision.json")
    if isinstance(decision, dict) and decision.get("decision") == "accept":
        print("success")
    else:
        print("invalid_evidence")
    raise SystemExit(0)

inspector_path = lens_dir / "preflight" / "inspector.json"
if inspector_path.is_file():
    inspector = read_json(inspector_path)
    if not isinstance(inspector, dict):
        print("invalid_evidence")
        raise SystemExit(0)
    if inspector.get("disposition") == "human_review":
        print("human_review")
        raise SystemExit(0)

for decision_path in sorted((lens_dir / "attempts").glob("*/*/decision.json")):
    decision = read_json(decision_path)
    if not isinstance(decision, dict):
        print("invalid_evidence")
        raise SystemExit(0)
    if decision.get("decision") == "human_review":
        print("human_review")
        raise SystemExit(0)

print("incomplete")
PY
}

printf 'Selected lenses (LC_ALL=C lexical order):\n'
for lens_id in "${LENS_IDS[@]}"; do
    printf '  %-48s %s\n' "$lens_id" "$(lens_state "$OUTPUT_DIR/$lens_id")"
done

if ((DRY_RUN)); then
    printf 'Dry run only: no directories, logs, sessions, or modeling artifacts were created.\n'
    exit 0
fi

mkdir -p -- "$OUTPUT_DIR"
LOCK_FILE="$OUTPUT_DIR/.lens-batch.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    die "another batch runner already holds the lock for $OUTPUT_DIR"
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)_$$"
LOG_ROOT="$OUTPUT_DIR/.orchestrator-logs"
RUN_LOG_DIR="$LOG_ROOT/$RUN_ID"
RUN_STATUS="$RUN_LOG_DIR/batch-status.tsv"
mkdir -p -- "$RUN_LOG_DIR"
printf 'lens_id\tstate\tsessions\tlast_codex_exit\n' >"$RUN_STATUS"

export CONDA_PREFIX="$CONDA_ENV"
export CONDA_DEFAULT_ENV="$CONDA_ENV"
export PATH="$CONDA_ENV/bin:$PATH"
unset LENS_AGENT_GPU_LEASE
export LENS_AGENT_REQUIRE_GPU_LEASE=1

current_child_pgid=''
interrupted=0
handle_signal() {
    interrupted=1
    if [[ -n $current_child_pgid ]]; then
        kill -TERM -- "-$current_child_pgid" 2>/dev/null || true
    fi
}
trap handle_signal INT TERM

write_public_status() {
    local temporary="$OUTPUT_DIR/.batch-status.$$.tmp"
    cp -- "$RUN_STATUS" "$temporary"
    mv -f -- "$temporary" "$OUTPUT_DIR/batch-status.tsv"
}

run_codex_session() {
    local lens_id=$1
    local session_number=$2
    local mode=$3
    local lens_input="$INPUT_DIR/$lens_id"
    local lens_result="$OUTPUT_DIR/$lens_id"
    local session_prefix="$RUN_LOG_DIR/${lens_id}.session-${session_number}"
    local session_log="${session_prefix}.log"
    local last_message="${session_prefix}.last-message.txt"
    local prompt

    prompt=$(printf '%s\n' \
        'Use $lens-model-orchestrator to process exactly one strong-lens system.' \
        "Repository Root: $REPO_DIR" \
        'Follow the skill Agent temporary files rules: the orchestrator creates the session directory and passes each Stage Expert its absolute Agent Temporary Directory.' \
        "Lens ID: $lens_id" \
        "Input Lens Directory: $lens_input" \
        "Lens Result Directory: $lens_result" \
        "Batch Output Directory: $OUTPUT_DIR" \
        "This invocation mode is: $mode." \
        'If a valid current Lens Result Directory exists, this is an explicit Lens Resume, never a Full Lens Rerun. Otherwise start a fresh Lens Run.' \
        'Do not process any other lens. Continue until filesystem evidence proves accepted M3 or canonical Human Review.' \
        "Use only $CONDA_ENV for lens modeling." \
        "Lens Agent Command: $CONDA_PYTHON -m lens_agent.cli" \
        "GPU Stage Command: $GPU_STAGE_RUNNER --python $CONDA_PYTHON" \
        'Pass this exact Lens Agent Command to every Stage Expert and require it for every non-stage lens-agent operation; never use a bare lens-agent or python command.' \
        'Pass this exact GPU Stage Command to every Stage Expert and require it for every physical stage operation.' \
        'Do not modify repository source code, input FITS, schemas, thresholds, retry budgets, the Packaged Pipeline, or the baseline classic pipeline.' \
        'Use English for every Lens Run message and every agent-authored natural-language field.' \
        'Do not run lens-agent summary; the outer batch runner will generate it after every selected lens is terminal.')

    printf '[%s] Starting Codex session %d for %s (%s).\n' \
        "$(date -Is)" "$session_number" "$lens_id" "$mode" | tee -a "$session_log"

    setsid "$CODEX_BIN" \
        -a never \
        -s danger-full-access \
        -C "$REPO_DIR" \
        --add-dir "$OUTPUT_DIR" \
        exec \
        --ephemeral \
        --color never \
        --output-last-message "$last_message" \
        - \
        <<<"$prompt" \
        > >(tee -a "$session_log") \
        2>&1 &
    current_child_pgid=$!
    local codex_status
    if wait "$current_child_pgid"; then
        codex_status=0
    else
        codex_status=$?
    fi
    current_child_pgid=''

    printf '[%s] Codex session %d for %s exited with status %d.\n' \
        "$(date -Is)" "$session_number" "$lens_id" "$codex_status" | tee -a "$session_log"
    return "$codex_status"
}

all_selected_terminal=1

for lens_id in "${LENS_IDS[@]}"; do
    if ((interrupted)); then
        break
    fi

    lens_result="$OUTPUT_DIR/$lens_id"
    state=$(lens_state "$lens_result")
    sessions=0
    last_codex_exit='-'

    case "$state" in
        success|human_review)
            printf '[%s] Skipping terminal lens %s (%s).\n' "$(date -Is)" "$lens_id" "$state"
            ;;
        invalid_evidence)
            printf '[%s] Invalid canonical evidence for %s; preserving it without an automatic rerun.\n' \
                "$(date -Is)" "$lens_id" >&2
            all_selected_terminal=0
            ;;
        not_started|incomplete)
            max_sessions=$((MAX_RESUMES + 1))
            while ((sessions < max_sessions)); do
                ((sessions += 1))
                if [[ $state == not_started && $sessions -eq 1 ]]; then
                    mode='fresh single-lens run'
                else
                    mode='explicit single-lens resume from canonical filesystem evidence'
                fi

                if run_codex_session "$lens_id" "$sessions" "$mode"; then
                    last_codex_exit=0
                else
                    last_codex_exit=$?
                fi

                if ((interrupted)); then
                    break
                fi

                state=$(lens_state "$lens_result")
                if [[ $state == success || $state == human_review || $state == invalid_evidence ]]; then
                    break
                fi
                printf '[%s] Lens %s remains incomplete; a fresh recovery session will be used if available.\n' \
                    "$(date -Is)" "$lens_id"
            done

            state=$(lens_state "$lens_result")
            if [[ $state != success && $state != human_review ]]; then
                all_selected_terminal=0
            fi
            ;;
        *)
            die "internal error: unknown lens state '$state' for $lens_id"
            ;;
    esac

    reported_state=$state
    if [[ $state == incomplete ]]; then
        reported_state='session_incomplete'
    elif [[ $state == not_started ]]; then
        if [[ $last_codex_exit != '-' && $last_codex_exit != 0 ]]; then
            reported_state='launcher_failed'
        else
            reported_state='session_incomplete'
        fi
    fi
    printf '%s\t%s\t%s\t%s\n' "$lens_id" "$reported_state" "$sessions" "$last_codex_exit" >>"$RUN_STATUS"
    write_public_status
done

if ((interrupted)); then
    write_public_status
    printf 'Batch interrupted. Existing lens evidence was preserved. Logs: %s\n' "$RUN_LOG_DIR" >&2
    exit 130
fi

all_output_terminal=1
while IFS= read -r result_dir; do
    state=$(lens_state "$result_dir")
    if [[ $state != success && $state != human_review ]]; then
        all_output_terminal=0
        printf 'Summary deferred: %s is %s.\n' "${result_dir##*/}" "$state" >&2
    fi
done < <(
    find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/preflight/inspection.json' \; -print \
        | LC_ALL=C sort
)

if ((all_selected_terminal && all_output_terminal)); then
    printf 'Every current lens result is terminal; generating summary.csv.\n'
    "$CONDA_PYTHON" -m lens_agent.cli summary --output-dir "$OUTPUT_DIR"
    printf 'Batch finished with terminal scientific states. Status: %s\n' "$OUTPUT_DIR/batch-status.tsv"
    exit 0
fi

printf 'Batch finished, but at least one lens has no canonical terminal state. Scientific evidence was preserved; summary.csv was not refreshed. Status: %s\n' \
    "$OUTPUT_DIR/batch-status.tsv" >&2
exit 1
