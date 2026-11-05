#!/usr/bin/env bash

set -Eeuo pipefail

MAX_MEMORY_USED_MB="${MAX_MEMORY_USED_MB:-2000}"
MAX_GPU_UTILIZATION="${MAX_GPU_UTILIZATION:-10}"
GPU_POLL_INTERVAL_SECONDS="${GPU_POLL_INTERVAL_SECONDS:-5}"
GPU_QUERY_LD_LIBRARY_PATH="${GPU_QUERY_LD_LIBRARY_PATH-}"
GPU_LOCK_ROOT="${GPU_LOCK_ROOT:-${TMPDIR:-/tmp}/agentic-lens-gpu-locks-$UID}"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 2
}

usage() {
    printf '%s\n' \
        "Usage: $(basename -- "$0") --python ABSOLUTE_PATH [--timeout-seconds N] -- STAGE_OPTIONS" \
        "" \
        "Prepare and validate, then acquire one idle GPU and run: PYTHON -m lens_agent.cli stage STAGE_OPTIONS"
}

python_path=''
timeout_seconds=''
while (($#)); do
    case "$1" in
        --python)
            (($# >= 2)) || die "--python requires a value"
            python_path=$2
            shift 2
            ;;
        --timeout-seconds)
            (($# >= 2)) || die "--timeout-seconds requires a value"
            timeout_seconds=$2
            shift 2
            ;;
        --)
            shift
            break
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

[[ $python_path == /* && -x $python_path ]] || die "--python must name an absolute executable"
[[ $MAX_MEMORY_USED_MB =~ ^[0-9]+$ ]] || die "MAX_MEMORY_USED_MB must be a non-negative integer"
[[ $MAX_GPU_UTILIZATION =~ ^[0-9]+$ ]] || die "MAX_GPU_UTILIZATION must be a non-negative integer"
[[ $GPU_POLL_INTERVAL_SECONDS =~ ^[1-9][0-9]*$ ]] || die "GPU_POLL_INTERVAL_SECONDS must be a positive integer"
if [[ -n $timeout_seconds && ! $timeout_seconds =~ ^[1-9][0-9]*$ ]]; then
    die "--timeout-seconds must be a positive integer"
fi
(($# > 0)) || die "stage options are required after --"

stage=''
stage_count=0
expect_stage_value=0
for argument in "$@"; do
    if ((expect_stage_value)); then
        stage=$argument
        ((stage_count += 1))
        expect_stage_value=0
        continue
    fi
    if [[ $argument == --stage ]]; then
        expect_stage_value=1
    fi
done
((stage_count == 1)) || die "stage options must contain exactly one --stage value"
[[ $stage =~ ^(a|b|m0|m1|m2|m3|subhalo)$ ]] || die "stage options must contain one valid --stage value"
if [[ $stage == a ]]; then
    [[ $timeout_seconds == 1800 ]] || die "Stage A requires --timeout-seconds 1800"
    command -v setsid >/dev/null 2>&1 || die "setsid is required for Stage A execution"
    command -v timeout >/dev/null 2>&1 || die "timeout is required for Stage A execution"
elif [[ -n $timeout_seconds ]]; then
    die "--timeout-seconds is supported only for Stage A"
fi

# Prepare and validate before GPU allocation. The physical command rechecks under its lock.
preparation_exit=0
preparation_output=$("$python_path" -m lens_agent.cli stage "$@" --prepare-only) || preparation_exit=$?
printf '%s\n' "$preparation_output"
if ((preparation_exit != 0)); then
    exit "$preparation_exit"
fi
preparation_status=$("$python_path" -c 'import json,sys; print(json.load(sys.stdin)["status"])' <<< "$preparation_output")
if [[ $preparation_status != prepared ]]; then
    # A completed success was returned without creating another physical execution.
    [[ $preparation_status == success ]] && exit 0
    exit 1
fi

# An explicit check-only request must not continue into GPU allocation.
for argument in "$@"; do
    if [[ $argument == --prepare-only ]]; then
        exit 0
    fi
done

export CUDA_DEVICE_ORDER=PCI_BUS_ID
export LENS_AGENT_GPU_LEASE=1

interrupted=0
stage_process_group=''
handle_signal() {
    interrupted=1
    if [[ -n $stage_process_group ]]; then
        kill -TERM -- "-$stage_process_group" 2>/dev/null || true
    fi
}
trap handle_signal INT TERM

run_stage() {
    printf '[%s] Assigned GPU %s to stage %s.\n' "$(date -Is)" "$CUDA_VISIBLE_DEVICES" "$stage" >&2
    if [[ -n $timeout_seconds ]]; then
        setsid --wait timeout --signal=TERM --kill-after=10s \
            "${timeout_seconds}s" "$python_path" -m lens_agent.cli stage "$@" &
        stage_process_group=$!
        local stage_status
        if wait "$stage_process_group"; then
            stage_status=0
        else
            stage_status=$?
        fi
        if ((interrupted)); then
            wait "$stage_process_group" 2>/dev/null || true
            stage_process_group=''
            return 130
        fi
        stage_process_group=''
        return "$stage_status"
    fi
    exec "$python_path" -m lens_agent.cli stage "$@"
}

if [[ ${CUDA_VISIBLE_DEVICES+x} ]]; then
    [[ $CUDA_VISIBLE_DEVICES =~ ^[0-9]+$ ]] || \
        die "existing CUDA_VISIBLE_DEVICES must identify exactly one GPU by numeric index"
    run_stage "$@"
    exit $?
fi

command -v nvidia-smi >/dev/null 2>&1 || die "nvidia-smi is required for GPU allocation"
command -v flock >/dev/null 2>&1 || die "flock is required for GPU allocation"
mkdir -p -- "$GPU_LOCK_ROOT"

while ((!interrupted)); do
    exec 9>"$GPU_LOCK_ROOT/allocation.lock"
    while ! flock -n 9; do
        if ((interrupted)); then
            break 2
        fi
        sleep 0.1 || true
    done
    if ((interrupted)); then
        break
    fi

    query_environment=()
    if [[ -n $GPU_QUERY_LD_LIBRARY_PATH && -d $GPU_QUERY_LD_LIBRARY_PATH ]]; then
        query_environment=(env "LD_LIBRARY_PATH=$GPU_QUERY_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}")
    fi
    if ! query_result=$("${query_environment[@]}" nvidia-smi \
        --query-gpu=index,name,memory.used,utilization.gpu \
        --format=csv,noheader,nounits); then
        flock -u 9
        die "nvidia-smi failed while querying GPUs"
    fi
    if ((interrupted)); then
        flock -u 9
        break
    fi

    if ! parsed_gpus=$(awk -F',' '
            /^[[:space:]]*$/ { next }
            {
                if (NF != 4) {
                    exit 2
                }
                for (field = 1; field <= 4; field++) {
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", $field)
                }
            }
            $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ {
                print $1 "\t" $2 "\t" $3 "\t" $4
                next
            }
            { exit 2 }
        ' <<<"$query_result"); then
        flock -u 9
        die "nvidia-smi returned an unparseable GPU inventory"
    fi
    if [[ -z $parsed_gpus ]]; then
        flock -u 9
        die "nvidia-smi returned no parseable whole GPUs"
    fi
    mapfile -t visible_gpus <<<"$parsed_gpus"

    mapfile -t candidates < <(
        printf '%s\n' "${visible_gpus[@]}" \
            | awk -F'\t' -v max_mem="$MAX_MEMORY_USED_MB" -v max_util="$MAX_GPU_UTILIZATION" \
                '$3 <= max_mem && $4 <= max_util { print $1 "\t" $3 "\t" $4 "\t" $2 }' \
            | sort -t $'\t' -k2,2n -k3,3n -k1,1n
    )

    selected_gpu=''
    selected_name=''
    for candidate in "${candidates[@]}"; do
        IFS=$'\t' read -r gpu_id memory_used utilization gpu_name <<<"$candidate"
        exec 8>"$GPU_LOCK_ROOT/gpu-${gpu_id}.lock"
        if flock -n 8; then
            selected_gpu=$gpu_id
            selected_name=$gpu_name
            break
        fi
    done
    flock -u 9

    if ((interrupted)); then
        if [[ -n $selected_gpu ]]; then
            flock -u 8
        fi
        break
    fi

    if [[ -n $selected_gpu ]]; then
        export CUDA_VISIBLE_DEVICES=$selected_gpu
        printf '[%s] GPU %s (%s) is idle (memory=%s MiB, utilization=%s%%).\n' \
            "$(date -Is)" "$selected_gpu" "$selected_name" "$memory_used" "$utilization" >&2
        stage_status=0
        run_stage "$@" || stage_status=$?
        exit "$stage_status"
    fi

    printf '[%s] No idle unlocked GPU is available; checking again in %s seconds.\n' \
        "$(date -Is)" "$GPU_POLL_INTERVAL_SECONDS" >&2
    if ((interrupted)); then
        break
    fi
    poll_ticks=$((GPU_POLL_INTERVAL_SECONDS * 10))
    for ((tick = 0; tick < poll_ticks && !interrupted; tick++)); do
        sleep 0.1 || true
    done
done

exit 130
