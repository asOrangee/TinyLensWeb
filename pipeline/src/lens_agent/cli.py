from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any

from .adjudication import adjudicate_attempt
from .attempts import prepare_attempt, promote_attempt
from .configuration import InputGeometry, PIPELINE_RELEASE_ID, validate_run_manifest, validated_run_root, run_input_geometry
from .inspection import build_inspection_packet, materialize_modeling_mask
from .inspector_decision import validate_inspector_decision
from .inspector_synthesis import record_inspector_votes, record_preflight_synthesis
from .models import StageName
from .rerun import prepare_full_rerun
from .result_paths import (
    is_archive_directory,
    require_lens_local_tree,
    require_no_archive_directory_ancestor,
    require_nonhistorical_lens_result,
    resolve_current_lens_result_path,
)
from .review_context import build_review_context
from .stage_input import StageInputError
from .stages import run_stage


MASS_PARAMETERS = (
    "theta_E",
    "gamma",
    "e1_mass",
    "e2_mass",
    "center_x_mass",
    "center_y_mass",
    "gamma1",
    "gamma2",
)


def _require_gpu_stage_lease() -> None:
    if os.environ.get("LENS_AGENT_REQUIRE_GPU_LEASE") != "1":
        return
    if os.environ.get("LENS_AGENT_GPU_LEASE") != "1":
        raise RuntimeError(
            "orchestrated physical stages must run through the GPU Stage Runner"
        )
    import jax

    gpu_devices = [device for device in jax.devices() if device.platform == "gpu"]
    if len(gpu_devices) != 1:
        raise RuntimeError(
            "the GPU Stage Runner lease must expose exactly one JAX GPU; "
            f"found {gpu_devices!r}"
        )


def _cmd_preflight(args: argparse.Namespace) -> None:
    output_dir = resolve_current_lens_result_path(args.output_dir)
    require_lens_local_tree(output_dir)
    require_nonhistorical_lens_result(output_dir)
    run_manifest = output_dir / "run-manifest.json"
    previous = validate_run_manifest(output_dir) if run_manifest.exists() else None
    base = run_input_geometry(output_dir) if previous is not None else InputGeometry()
    values = base.model_dump()
    for name in InputGeometry.model_fields:
        value = getattr(args, name, None)
        if value is not None:
            values[name] = value
    geometry = InputGeometry.model_validate(values, strict=True)
    if previous is not None and geometry != base:
        raise ValueError("Input geometry is frozen for this run; use a new output or Full Lens Rerun")
    lens_dir = args.lens_dir.resolve()
    if previous is not None and previous.get("lens_dir", str(lens_dir)) != str(lens_dir):
        raise ValueError("Input directory is frozen for this run; use a new output or Full Lens Rerun")
    output_dir.mkdir(parents=True, exist_ok=True)
    if previous is None:
        manifest = {
            "schema_version": "lens_run_manifest.v1",
            "pipeline_release_id": PIPELINE_RELEASE_ID,
            "lens_dir": str(lens_dir),
            "input_geometry": geometry.model_dump(mode="json"),
            "geometry_evidence": getattr(args, "geometry_evidence", None),
        }
        run_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    packet = build_inspection_packet(lens_dir, output_dir / "preflight", geometry=geometry)
    print(packet)


def _cmd_mask(args: argparse.Namespace) -> None:
    output_dir = validated_run_root(args.output_dir)
    preflight_dir = output_dir / "preflight"
    geometry = run_input_geometry(output_dir)
    decision_path = args.inspection.resolve()
    saved_decision = preflight_dir / "inspector.json"
    try:
        decision = validate_inspector_decision(
            json.loads(decision_path.read_text(encoding="utf-8")),
            expected_lens_id=output_dir.name,
        )
    except (ValueError, json.JSONDecodeError):
        if decision_path == saved_decision.resolve():
            saved_decision.unlink(missing_ok=True)
        raise
    saved_decision.write_text(
        json.dumps(decision, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    disposition = decision.get("disposition")
    if disposition == "human_review":
        (preflight_dir / "modeling_mask.fits").unlink(missing_ok=True)
        print("human_review")
        return
    if disposition != "model":
        raise ValueError("inspector disposition must be 'model' or 'human_review'")
    contaminants = [int(value) for value in decision.get("contaminant_ids", [])]
    mask = materialize_modeling_mask(preflight_dir, contaminants, pixel_scale_arcsec=geometry.pixel_scale_arcsec)
    print(mask)


def _cmd_inspector_votes(args: argparse.Namespace) -> None:
    for target in record_inspector_votes(args.output_dir, args.response):
        print(target)


def _cmd_inspector_synthesis(args: argparse.Namespace) -> None:
    print(record_preflight_synthesis(args.output_dir, args.response))


def _cmd_stage(args: argparse.Namespace) -> None:
    from .operations import StageBusy, PreparationBlocked, operation_result

    try:
        if not args.prepare_only:
            _require_gpu_stage_lease()
        result = run_stage(
            args.lens_dir,
            args.output_dir,
            StageName(args.stage),
            args.attempt,
            prepare_only=args.prepare_only,
            preview_only=args.preview_only,
        )
    except (StageBusy, PreparationBlocked) as error:
        busy = isinstance(error, StageBusy)
        print(json.dumps(operation_result("busy" if busy else "preparation_blocked", error)),
              file=sys.stderr)
        raise SystemExit(75 if busy else 2) from None
    except StageInputError as error:
        print(json.dumps(operation_result("preparation_blocked", error)), file=sys.stderr)
        raise SystemExit(2) from None
    try:
        print(json.dumps(result, indent=2), flush=True)
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except (AttributeError, BrokenPipeError, OSError):
            pass
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if result["status"] not in {"success", "prepared"}:
        raise SystemExit(1)


def _cmd_attempt_prepare(args: argparse.Namespace) -> None:
    target = prepare_attempt(
        args.output_dir,
        StageName(args.stage),
        args.attempt,
    )
    print(target)


def _cmd_attempt_promote(args: argparse.Namespace) -> None:
    target = promote_attempt(
        args.output_dir,
        StageName(args.stage),
        args.attempt,
    )
    print(target)


def _cmd_review_context(args: argparse.Namespace) -> None:
    target = build_review_context(
        args.output_dir,
        StageName(args.stage),
        args.attempt,
    )
    print(target)


def _cmd_review_adjudicate(args: argparse.Namespace) -> None:
    target = adjudicate_attempt(
        args.output_dir,
        StageName(args.stage),
        args.attempt,
        response=args.response,
        failure=args.failure,
    )
    print(target)


def _cmd_rerun_prepare(args: argparse.Namespace) -> None:
    print(prepare_full_rerun(args.output_dir))


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _latest_decision(lens_dir: Path) -> dict[str, Any] | None:
    decisions = sorted(
        (lens_dir / "attempts" / "m3").glob("*/decision.json"),
        key=lambda path: int(path.parent.name) if path.parent.name.isdigit() else -1,
    )
    return _read_json(decisions[-1]) if decisions else None


def _human_review_decision(lens_dir: Path) -> dict[str, Any] | None:
    decisions = sorted((lens_dir / "attempts").glob("*/*/decision.json"))
    for path in decisions:
        if path.parent.parent.name == "subhalo":
            continue
        decision = _read_json(path)
        if decision and decision.get("decision") == "human_review":
            return decision
    return None


def _format_posterior(summary: dict[str, Any]) -> str:
    try:
        return f"{float(summary['q50']):.6g} [{float(summary['q16']):.6g}, {float(summary['q84']):.6g}]"
    except (KeyError, TypeError, ValueError):
        return ""


def _summary_row(lens_dir: Path) -> dict[str, str]:
    row = {name: "" for name in ("lens_id", "status", "diagnosis", *MASS_PARAMETERS, "result_dir")}
    from .subhalo import summary_fields
    row.update(summary_fields(lens_dir))
    row["lens_id"] = lens_dir.name
    row["result_dir"] = str(lens_dir.resolve())
    inspector = _read_json(lens_dir / "preflight" / "inspector.json")
    if inspector and inspector.get("disposition") == "human_review":
        row.update(status="human_review", diagnosis=str(inspector.get("reason", "preflight requires human review")))
        return row
    human_review = _human_review_decision(lens_dir)
    if human_review:
        row.update(status="human_review", diagnosis=str(human_review.get("reason", "stage requires human review")))
        return row
    head_path = lens_dir / "accepted" / "m3.json"
    head = _read_json(head_path)
    decision = _latest_decision(lens_dir)
    if not head:
        reason = (decision or {}).get("reason", "no accepted M3 decision")
        row.update(status="human_review", diagnosis=str(reason))
        return row
    attempt_dir = (head_path.parent / str(head.get("attempt_path", ""))).resolve()
    try:
        attempt_dir.relative_to(lens_dir.resolve())
    except ValueError:
        row.update(status="human_review", diagnosis="accepted M3 head escapes the lens result directory")
        return row
    decision = _read_json(attempt_dir / "decision.json")
    if not decision or decision.get("decision") != "accept":
        row.update(status="human_review", diagnosis="accepted M3 head has no accept decision")
        return row
    stage_result = _read_json(attempt_dir / "stage-result.json") or {}
    gate_failures = stage_result.get("gate_failures") or []
    if (
        stage_result.get("status") != "success"
        or stage_result.get("eligible_for_review") is not True
        or gate_failures
    ):
        reason = "; ".join(str(value) for value in gate_failures)
        if not reason:
            reason = str(stage_result.get("error") or "M3 result is not eligible for acceptance")
        row.update(status="human_review", diagnosis=reason)
        return row
    posterior = stage_result.get("metrics", {}).get("posterior_quantiles", {})
    row.update(status="success", diagnosis=str(decision.get("reason", "")))
    for parameter in MASS_PARAMETERS:
        row[parameter] = _format_posterior(posterior.get(parameter, {}))
    return row


def _cmd_subhalo_candidate(args):
    from .subhalo import register_candidate
    print(register_candidate(args.output_dir, args.response))


def _cmd_subhalo_confirm(args):
    from .subhalo import confirm_preview
    print(confirm_preview(args.output_dir))


def _cmd_summary(args: argparse.Namespace) -> None:
    require_no_archive_directory_ancestor(args.output_dir)
    output_dir = args.output_dir.resolve()
    lens_dirs = []
    for path in sorted(output_dir.iterdir()):
        if path.is_symlink() or not path.is_dir() or is_archive_directory(path):
            continue
        if not (path / "preflight" / "inspection.json").is_file():
            continue
        require_lens_local_tree(path)
        lens_dirs.append(path)
    from .subhalo import SUBHALO_SUMMARY_FIELDS
    fields = ["lens_id", "status", "diagnosis", *MASS_PARAMETERS, "result_dir", *SUBHALO_SUMMARY_FIELDS]
    rows = [_summary_row(path) for path in lens_dirs]
    target = output_dir / "summary.csv"
    if target.is_symlink():
        raise ValueError("summary.csv must not be a symbolic link")
    with target.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(target)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lens-agent")
    commands = parser.add_subparsers(dest="command", required=True)

    preflight = commands.add_parser("preflight")
    preflight.add_argument("--lens-dir", type=Path, required=True)
    preflight.add_argument("--output-dir", type=Path, required=True)
    preflight.add_argument("--pixel-scale-arcsec", type=float, default=None,
                           help="Calibrated square-pixel size in arcsec; default 0.1 for a new run")
    preflight.add_argument("--input-x-direction", choices=["increasing", "decreasing"], default=None,
                           help="Physical x direction as input column index increases")
    preflight.add_argument("--input-y-direction", choices=["increasing", "decreasing"], default=None,
                           help="Physical y direction as input row index increases")
    preflight.add_argument("--geometry-evidence", default=None,
                           help="Header, simulation metadata or calibration supporting the input geometry")
    preflight.set_defaults(func=_cmd_preflight)

    mask = commands.add_parser("mask")
    mask.add_argument("--output-dir", type=Path, required=True)
    mask.add_argument("--inspection", type=Path, required=True)
    mask.set_defaults(func=_cmd_mask)

    inspector = commands.add_parser("inspector")
    inspector_commands = inspector.add_subparsers(
        dest="inspector_command", required=True
    )
    votes = inspector_commands.add_parser("votes")
    votes.add_argument("--output-dir", type=Path, required=True)
    votes.add_argument("--response", type=Path, action="append", required=True)
    votes.set_defaults(func=_cmd_inspector_votes)
    synthesis = inspector_commands.add_parser("synthesis")
    synthesis.add_argument("--output-dir", type=Path, required=True)
    synthesis.add_argument("--response", type=Path, required=True)
    synthesis.set_defaults(func=_cmd_inspector_synthesis)

    attempt = commands.add_parser("attempt")
    attempt_commands = attempt.add_subparsers(dest="attempt_command", required=True)
    prepare = attempt_commands.add_parser("prepare")
    prepare.add_argument("--output-dir", type=Path, required=True)
    prepare.add_argument(
        "--stage", choices=[stage.value for stage in StageName], required=True
    )
    prepare.add_argument("--attempt", type=int, required=True)
    prepare.set_defaults(func=_cmd_attempt_prepare)
    promote = attempt_commands.add_parser("promote")
    promote.add_argument("--output-dir", type=Path, required=True)
    promote.add_argument(
        "--stage", choices=[stage.value for stage in StageName], required=True
    )
    promote.add_argument("--attempt", type=int, required=True)
    promote.set_defaults(func=_cmd_attempt_promote)

    stage = commands.add_parser("stage", allow_abbrev=False)
    stage.add_argument("--lens-dir", type=Path, required=True)
    stage.add_argument("--output-dir", type=Path, required=True)
    stage.add_argument("--stage", choices=[stage.value for stage in StageName], required=True)
    stage.add_argument("--attempt", type=int, required=True)
    stage.add_argument(
        "--prepare-only",
        action="store_true",
        help="validate inputs and prepare configuration without GPU use or computation",
    )
    stage.add_argument("--preview-only", action="store_true",
                       help="render the subhalo candidate using M3, without sampling")
    stage.set_defaults(func=_cmd_stage)

    review = commands.add_parser("review")
    review_commands = review.add_subparsers(dest="review_command", required=True)
    context = review_commands.add_parser("context")
    context.add_argument("--output-dir", type=Path, required=True)
    context.add_argument(
        "--stage", choices=[stage.value for stage in StageName], required=True
    )
    context.add_argument("--attempt", type=int, required=True)
    context.set_defaults(func=_cmd_review_context)
    adjudicate = review_commands.add_parser("adjudicate")
    adjudicate.add_argument("--output-dir", type=Path, required=True)
    adjudicate.add_argument(
        "--stage", choices=[stage.value for stage in StageName], required=True
    )
    adjudicate.add_argument("--attempt", type=int, required=True)
    adjudicate.add_argument("--response", type=Path)
    adjudicate.add_argument(
        "--failure",
        choices=[
            "stage_a_timeout",
            "incomplete_stage_execution",
            "response_contract_failure",
        ],
    )
    adjudicate.set_defaults(func=_cmd_review_adjudicate)

    rerun = commands.add_parser("rerun")
    rerun_commands = rerun.add_subparsers(dest="rerun_command", required=True)
    rerun_prepare = rerun_commands.add_parser("prepare")
    rerun_prepare.add_argument("--output-dir", type=Path, required=True)
    rerun_prepare.set_defaults(func=_cmd_rerun_prepare)

    subhalo = commands.add_parser("subhalo")
    subhalo_commands = subhalo.add_subparsers(dest="subhalo_command", required=True)
    candidate = subhalo_commands.add_parser("candidate")
    candidate.add_argument("--output-dir", type=Path, required=True)
    candidate.add_argument("--response", type=Path, required=True)
    candidate.set_defaults(func=_cmd_subhalo_candidate)
    confirm = subhalo_commands.add_parser("confirm")
    confirm.add_argument("--output-dir", type=Path, required=True)
    confirm.set_defaults(func=_cmd_subhalo_confirm)

    summary = commands.add_parser("summary")
    summary.add_argument("--output-dir", type=Path, required=True)
    summary.set_defaults(func=_cmd_summary)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
