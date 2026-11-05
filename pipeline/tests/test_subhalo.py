"""Scientific and lifecycle checks for the optional SIS search."""
import json
from pathlib import Path

import numpy as np
import pytest
import jsonschema

from lens_agent.adjudication import adjudicate_attempt, _retry_budget_snapshot
from lens_agent.attempts import promote_attempt, _apply_proposal, _Proposal
from lens_agent.configuration import EffectiveConfig
from lens_agent.contracts import validate_reviewer_response
from lens_agent.models import StageName, STAGE_ORDER
from lens_agent.subhalo import (
    SubhaloCandidate, detection_status, register_candidate, load_candidate,
    confirm_preview, validate_preview_confirmation, summary_fields,
)
from tests.test_adjudication import _eligible_attempt, _accepted_review


def _review(improved=True):
    return {**_accepted_review("subhalo"), "scientific_uncertainty": None,
            "residual_improved": improved}


def test_subhalo_review_context_keeps_m3_settings_read_only(tmp_path):
    from lens_agent.review_context import build_review_context

    output, _ = _eligible_attempt(tmp_path, "subhalo")
    context = json.loads(build_review_context(output, StageName.SUBHALO, 0).read_text())
    settings = context["settings"]
    assert {name for name, item in settings.items() if item["tunable"]} == {
        "stage_subhalo_n_live", "stage_subhalo_n_eff",
    }
    defaults = EffectiveConfig().settings.model_dump(mode="json")
    for name, value in defaults.items():
        if name.startswith("stage_m3_"):
            assert settings[name] == {"value": value, "tunable": False}


@pytest.mark.parametrize("parameter,old,new", [("n_live", 300, 400), ("n_eff", 600, 800)])
def test_subhalo_cannot_submit_m3_sampling_changes(tmp_path, parameter, old, new):
    output, root = _eligible_attempt(tmp_path, "subhalo")
    original_config = (root / "effective-config.json").read_bytes()
    review = _review(False)
    review["progression_blockers"] = [{"kind": "sampling_pathology",
        "evidence": ["Posterior quantiles are unstable."], "impact": "Evidence is unreliable."}]
    review["retry_repair"] = {
        "hypothesis": {"blocker_kind": "sampling_pathology", "expected_improvement": "Stable posterior."},
        "proposal": {"base_config": "attempts/subhalo/0/effective-config.json",
                     "parameter": f"stage_m3_{parameter}", "old_value": old, "new_value": new}}
    response = tmp_path / "review.json"
    response.write_text(json.dumps(review))
    with pytest.raises(ValueError, match="belongs to another stage"):
        adjudicate_attempt(output, StageName.SUBHALO, 0, response=response)
    assert (root / "effective-config.json").read_bytes() == original_config
    assert not (root / "review.json").exists()
    assert not (root / "decision.json").exists()


@pytest.mark.parametrize("delta,improved,status", [
    (9.99, True, "not_significant"), (10., True, "significant"),
    (12., True, "significant"), (20., False, "not_significant"),
    (-10., True, "not_significant"),
])
def test_detection_requires_both_evidence_and_visual_improvement(tmp_path, delta, improved, status):
    output, root = _eligible_attempt(tmp_path, "subhalo")
    result = json.loads((root / "stage-result.json").read_text())
    result["metrics"] = {"delta_log_z": delta}
    (root / "stage-result.json").write_text(json.dumps(result))
    response = tmp_path / "review.json"
    response.write_text(json.dumps(_review(improved)))
    target = adjudicate_attempt(output, StageName.SUBHALO, 0, response=response)
    decision = json.loads(target.read_text())
    assert decision["decision"] == "accept"
    assert decision["subhalo_status"] == status
    promote_attempt(output, StageName.SUBHALO, 0)
    assert summary_fields(output)["subhalo_status"] == status


def test_nonphysical_result_is_not_reported_as_nondetection(tmp_path):
    output, root = _eligible_attempt(tmp_path, "subhalo")
    review = _review()
    review["progression_blockers"] = [{"kind": "material_prior_truncation",
        "evidence": ["SIS posterior is materially cut off at the upper theta_E limit"],
        "impact": "The mass inference is not credible."}]
    response = tmp_path / "review.json"
    response.write_text(json.dumps(review))
    decision = json.loads(adjudicate_attempt(output, StageName.SUBHALO, 0, response=response).read_text())
    assert decision["decision"] == "human_review"
    assert "subhalo_status" not in decision
    with pytest.raises(ValueError):
        promote_attempt(output, StageName.SUBHALO, 0)


def test_subhalo_review_schema_agrees_with_python():
    schema = json.loads(Path('.codex/evals/stage-subhalo-expert-output.schema.json').read_text())
    review = _review()
    jsonschema.validate(review, schema)
    validate_reviewer_response(review, StageName.SUBHALO)
    del review["residual_improved"]
    with pytest.raises(ValueError):
        validate_reviewer_response(review, StageName.SUBHALO)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(review, schema)


def _accepted_m3(tmp_path, *, legacy_config=False):
    output, root = _eligible_attempt(tmp_path, "m3")
    if legacy_config:
        config_path = root / "effective-config.json"
        config = json.loads(config_path.read_text())
        for name in ("stage_subhalo_n_live", "stage_subhalo_n_eff"):
            del config["settings"][name]
        config_path.write_text(json.dumps(config))
    result = json.loads((root / "stage-result.json").read_text())
    result["metrics"] = {"log_z": 40.}
    (root / "stage-result.json").write_text(json.dumps(result))
    response = tmp_path / "review.json"
    response.write_text(json.dumps(_accepted_review("m3")))
    adjudicate_attempt(output, StageName.M3, 0, response=response)
    promote_attempt(output, StageName.M3, 0)
    return output, root


@pytest.mark.parametrize("has_candidate", [True, False])
def test_candidate_registration_preserves_m3_and_locks_search(tmp_path, monkeypatch, has_candidate):
    output, m3 = _accepted_m3(tmp_path)
    before = {str(f): f.read_bytes() for f in m3.rglob('*') if f.is_file()}
    monkeypatch.setattr("lens_agent.stages._accepted_upstream_dirs", lambda *a, **kw: {})
    candidate = {"status": "candidate" if has_candidate else "no_candidate",
                 "center_x": -.8 if has_candidate else None,
                 "center_y": -.4 if has_candidate else None, "reason": "Local residual assessment."}
    response = tmp_path / "candidate.json"
    response.write_text(json.dumps(candidate))
    target = register_candidate(output, response)
    assert register_candidate(output, response) == target
    assert load_candidate(output)["status"] == candidate["status"]
    record = load_candidate(output)
    assert record["sigma_x"] == record["sigma_y"] == 0.2
    assert record["theta_E_limits"] == [0.0, 0.2]
    assert before == {str(f): f.read_bytes() for f in m3.rglob('*') if f.is_file()}
    if not has_candidate:
        assert summary_fields(output)["subhalo_status"] == "no_candidate"
        with pytest.raises(ValueError, match="no candidate"):
            load_candidate(output, require_candidate=True)
    candidate["reason"] = "A different candidate after inspecting the outcome."
    response.write_text(json.dumps(candidate))
    with pytest.raises(ValueError, match="locked"):
        register_candidate(output, response)


def test_historical_candidate_keeps_original_priors(tmp_path, monkeypatch):
    output, _ = _accepted_m3(tmp_path)
    monkeypatch.setattr("lens_agent.stages._accepted_upstream_dirs", lambda *a, **kw: {})
    response = tmp_path / "candidate.json"
    response.write_text(json.dumps(dict(status="candidate", center_x=-.8, center_y=-.4, reason="Local residual.")))
    target = register_candidate(output, response)
    historical = json.loads(target.read_text())
    historical.update(sigma_x=0.1, sigma_y=0.1, theta_E_limits=[0.0, 0.1])
    target.write_text(json.dumps(historical))
    before = target.read_bytes()
    assert load_candidate(output, require_candidate=True) == historical
    assert summary_fields(output)["subhalo_status"] == "incomplete"
    assert target.read_bytes() == before


def test_preview_and_retry_preserve_candidate(tmp_path, monkeypatch):
    output, _ = _accepted_m3(tmp_path)
    monkeypatch.setattr("lens_agent.stages._accepted_upstream_dirs", lambda *a, **kw: {})
    response = tmp_path / "candidate.json"
    response.write_text(json.dumps(dict(status="candidate", center_x=-.8, center_y=-.4, reason="Local residual.")))
    candidate_path = register_candidate(output, response)
    root = output / "attempts/subhalo/0"
    (root / "preview").mkdir(parents=True)
    (root / "subhalo-candidate.json").write_bytes(candidate_path.read_bytes())
    (root / "preview/subhalo_candidate.png").write_bytes(b"preview pixels")
    confirm_preview(output)
    validate_preview_confirmation(root)
    retry = root.parent / "1"
    retry.mkdir()
    (retry / "subhalo-candidate.json").write_bytes(candidate_path.read_bytes())
    validate_preview_confirmation(retry)
    (retry / "subhalo-candidate.json").write_text('{}')
    with pytest.raises(ValueError, match="preserve"):
        validate_preview_confirmation(retry)


def test_retry_budget_and_monotonic_sampling(tmp_path):
    snapshot, reason = _retry_budget_snapshot(tmp_path, StageName.SUBHALO)
    assert snapshot == {"stage_used": 0, "stage_limit": 2}
    assert reason is None
    assert StageName.SUBHALO not in STAGE_ORDER
    config = EffectiveConfig()
    proposal = _Proposal(base_config="current", parameter="stage_subhalo_n_eff", old_value=1000, new_value=900)
    with pytest.raises(ValueError, match="increase"):
        _apply_proposal(config, proposal, "sampling_pathology", StageName.SUBHALO, "current")


@pytest.mark.parametrize("n_live", [5000, 5001, 6000])
def test_subhalo_live_point_limit_agrees_between_schema_and_execution(n_live):
    values = EffectiveConfig().model_dump(mode="json")
    values["settings"]["stage_subhalo_n_eff"] = 10000
    parent = EffectiveConfig.model_validate_json(json.dumps(values), strict=True)
    proposal = _Proposal(
        base_config="attempts/subhalo/1/effective-config.json",
        parameter="stage_subhalo_n_live", old_value=600, new_value=n_live,
    )
    schema = json.loads(Path('.codex/evals/stage-subhalo-expert-output.schema.json').read_text())
    proposal_schema = {"$ref": "#/$defs/proposal", "$defs": schema["$defs"]}
    if n_live <= 5000:
        jsonschema.validate(proposal.model_dump(), proposal_schema)
        settings = _apply_proposal(
            parent, proposal, "sampling_pathology", StageName.SUBHALO, proposal.base_config
        )
        assert settings.stage_subhalo_n_live == n_live
    else:
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(proposal.model_dump(), proposal_schema)
        with pytest.raises(ValueError, match="Tuning Safety Envelope"):
            _apply_proposal(
                parent, proposal, "sampling_pathology", StageName.SUBHALO, proposal.base_config
            )


def test_existing_config_loads_without_subhalo_fields():
    values = EffectiveConfig().model_dump(mode="json")
    del values["settings"]["stage_subhalo_n_live"]
    del values["settings"]["stage_subhalo_n_eff"]
    loaded = EffectiveConfig.model_validate_json(json.dumps(values))
    assert loaded.settings.stage_subhalo_n_live == 600
    assert loaded.settings.stage_subhalo_n_eff == 1000


def test_real_transfer_and_zero_sis_recover_macro_deflection():
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling import subhalo as s
    from TinyLensGpu.Inference import StagePosterior
    from TinyLensGpu.Inference.build_prior import make_prior_transformation
    names = ["theta_E", "gamma", "e1_mass", "e2_mass", "gamma1", "gamma2"]
    med = np.array([.8, 2., .1, -.1, .03, .1])
    m3 = StagePosterior(np.stack([med-.001, med, med+.001]), np.ones(3), names)
    a = StagePosterior(np.array([[.03, -.02], [.03, -.02]]), np.ones(2), ["center_x_mass", "center_y_mass"])
    macro = s.mass_from_m3(m3, a)
    candidate = dict(center_x=-.85, center_y=-.45, sigma_x=.2, sigma_y=.2, theta_E_limits=[0., .2])
    sis = s.sis_from_candidate(candidate)
    image = np.ones((8, 8))
    def likelihood(profiles):
        source = s.p.PixelizedSourceModel(n=4, log_lambda_reg=0., adaptive_reg_rho=1., regularization_type="first-order")
        return s.p._pixel_likelihood(image, image, np.ones((1,1)), np.zeros_like(image, dtype=bool),
            None, profiles, source, None, fixed_source_bbox=(-.2,.2,-.2,.2), fixed_reg_template=np.ones(16))
    model = likelihood((*macro, sis))
    _, specs = make_prior_transformation(model)
    assert {spec.name for spec in specs} == set(names) | {"theta_E_subhalo", "center_x_subhalo", "center_y_subhalo"}
    by_name = {spec.name: spec for spec in specs}
    assert by_name["theta_E_subhalo"].settings == pytest.approx([0., .2])
    assert by_name["center_x_subhalo"].settings == pytest.approx([-.85, .2])
    assert by_name["center_y_subhalo"].settings == pytest.approx([-.45, .2])
    assert by_name["gamma"].settings == pytest.approx(m3.conservative_sigma("gamma", "EPL", "gamma"))
    assert float(macro[0].center_x.value) == pytest.approx(.03)
    assert float(macro[0].center_y.value) == pytest.approx(-.02)
    import jax.numpy as jnp
    import caskade as ck
    x = jnp.array([-.7, .3, .8]); y = jnp.array([-.5, .6, .2])
    params = m3.medians() | dict(theta_E_subhalo=0., center_x_subhalo=-.85, center_y_subhalo=-.45)
    with ck.ActiveContext(model):
        model.fill_params(jnp.array([params[spec.name] for spec in specs]))
        dx, dy = sis.deriv(x, y)
        np.testing.assert_allclose(dx, 0., atol=1e-8)
        np.testing.assert_allclose(dy, 0., atol=1e-8)
    base = likelihood(s.mass_from_m3(m3, a))
    # A zero SIS also leaves the reconstructed pixel-source prediction unchanged.
    combined = s.p._solve_source(model, params, [spec.name for spec in specs])
    pure = s.p._solve_source(base, m3.medians(), names)
    np.testing.assert_allclose(combined["model_1d"], pure["model_1d"], rtol=2e-4, atol=2e-5)


def test_candidate_coordinate_extent():
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling.subhalo import image_extent
    assert image_extent((20, 30)) == (-1.5, 1.5, -1., 1.)


@pytest.mark.parametrize("values", [
    dict(status="candidate", center_x=None, center_y=0.),
    dict(status="no_candidate", center_x=0., center_y=None),
    dict(status="candidate", center_x=float('nan'), center_y=0.),
])
def test_invalid_candidate_cannot_enter_model(values):
    with pytest.raises(ValueError):
        SubhaloCandidate(**values, reason="test")


@pytest.mark.parametrize("legacy_config", [False, True])
def test_preview_then_fit_resume_and_promote_in_existing_run(tmp_path, monkeypatch, legacy_config):
    from types import SimpleNamespace
    from lens_agent import stages
    from lens_agent.operations import PreparationBlocked
    from astropy.io import fits
    output, m3 = _accepted_m3(tmp_path, legacy_config=legacy_config)
    preserved_paths = [p for p in m3.rglob("*") if p.is_file()]
    preserved_paths += [output / "accepted/m3.json", output / "run-manifest.json"]
    before = {p: p.read_bytes() for p in preserved_paths}
    monkeypatch.setattr(stages, "_accepted_upstream_dirs", lambda *a, **kw: {})
    lens = tmp_path / "lens-001"
    lens.mkdir()
    fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU(np.ones((4, 4)), name="VIS_FLUX"),
        fits.ImageHDU(np.ones((4, 4)), name="VIS_RMS"),
        fits.ImageHDU(np.ones((1, 1)), name="VIS_PSF"),
    ]).writeto(lens / "lens-001.fits")
    (output / "preflight").mkdir()
    (output / "preflight/inspection.json").write_text(json.dumps({"lens_dir": str(lens)}))
    (output / "preflight/inspector.json").write_text(json.dumps({"disposition": "model"}))
    fits.writeto(output / "preflight/modeling_mask.fits", np.zeros((4,4), dtype=np.uint8))
    response = tmp_path / "candidate.json"
    response.write_text(json.dumps(dict(status="candidate", center_x=-.1, center_y=-.1, reason="Local residual.")))
    register_candidate(output, response)
    pipeline = SimpleNamespace()
    def configure(**kw):
        pipeline.OUT_DIR = kw["artifact_dir"]
        pipeline.DIAGNOSTICS_DIR = kw["diagnostics_dir"]
    pipeline.configure_runtime = configure
    monkeypatch.setattr(stages, "_load_packaged_pipeline", lambda: pipeline)
    calls = []
    def preview(pipeline, *args, **kw):
        calls.append("preview")
        pipeline.DIAGNOSTICS_DIR.mkdir(exist_ok=True)
        (pipeline.DIAGNOSTICS_DIR / "subhalo_candidate.png").write_bytes(b"preview")
    monkeypatch.setattr(stages, "_stage_subhalo", preview)
    def fit(pipeline, *args):
        calls.append("fit")
        (pipeline.OUT_DIR / "posterior").write_bytes(b"posterior")
    monkeypatch.setitem(stages.RUNNERS, StageName.SUBHALO, fit)
    monkeypatch.setattr(stages, "_summarize", lambda *args: (
        {"posterior": "artifacts/posterior"}, {"delta_log_z": 9.0}))
    with pytest.raises(PreparationBlocked):
        stages.run_stage(lens, output, StageName.SUBHALO, 0)
    root = output / "attempts/subhalo/0"
    assert not (root / "stage-execution.json").exists()
    assert stages.run_stage(lens, output, StageName.SUBHALO, 0, preview_only=True)["sampling_started"] is False
    assert not (root / "stage-execution.json").exists()
    confirm_preview(output)
    result = stages.run_stage(lens, output, StageName.SUBHALO, 0)
    assert result["eligible_for_review"] is True
    assert stages.run_stage(lens, output, StageName.SUBHALO, 0) == result
    assert calls == ["preview", "fit"]
    response.write_text(json.dumps(_review()))
    adjudicate_attempt(output, StageName.SUBHALO, 0, response=response)
    promote_attempt(output, StageName.SUBHALO, 0)
    assert json.loads((output / "accepted/m3.json").read_text())["accepted_attempt"] == 0
    assert {p: p.read_bytes() for p in preserved_paths} == before


@pytest.mark.parametrize("parameter,old,new", [("n_live",600,800), ("n_eff",1000,2000)])
def test_subhalo_sampling_retry_schema_and_adjudication(tmp_path, parameter, old, new):
    output, root = _eligible_attempt(tmp_path, "subhalo")
    review = _review(False)
    review["progression_blockers"] = [{"kind": "sampling_pathology",
        "evidence": ["Posterior quantiles are unstable."], "impact": "Evidence is unreliable."}]
    review["retry_repair"] = {
        "hypothesis": {"blocker_kind": "sampling_pathology", "expected_improvement": "Stable posterior."},
        "proposal": {"base_config": "attempts/subhalo/0/effective-config.json",
                     "parameter": f"stage_subhalo_{parameter}", "old_value": old, "new_value": new}}
    schema = json.loads(Path('.codex/evals/stage-subhalo-expert-output.schema.json').read_text())
    jsonschema.validate(review, schema)
    response = tmp_path / "review.json"
    response.write_text(json.dumps(review))
    decision = json.loads(adjudicate_attempt(output, StageName.SUBHALO, 0, response=response).read_text())
    assert decision["decision"] == "retry"
    assert decision["retry_budget"] == {"stage_used": 0, "stage_limit": 2}


def test_subhalo_failure_preserves_m3_summary_status(tmp_path):
    from lens_agent.cli import _summary_row
    output, _ = _accepted_m3(tmp_path)
    subhalo = output / "attempts/subhalo/0"
    subhalo.mkdir(parents=True)
    (subhalo / "decision.json").write_text(json.dumps({"decision": "human_review", "reason": "Unreliable subhalo fit."}))
    row = _summary_row(output)
    assert row["status"] == "success"
    assert row["subhalo_status"] == "human_review"


def test_subhalo_hard_gate_failure_cannot_be_promoted(tmp_path):
    output, root = _eligible_attempt(tmp_path, "subhalo")
    result_path = root / "stage-result.json"
    result = json.loads(result_path.read_text())
    result.update(eligible_for_review=False, gate_failures=["non-finite evidence"])
    result_path.write_text(json.dumps(result))
    decision = json.loads(adjudicate_attempt(output, StageName.SUBHALO, 0, response=None).read_text())
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "operational_failure"
    with pytest.raises(ValueError, match="Hard Gate"):
        promote_attempt(output, StageName.SUBHALO, 0)


def test_subhalo_two_retry_budget_is_terminal(tmp_path):
    for number in (1, 2):
        root = tmp_path / "attempts/subhalo" / str(number)
        root.mkdir(parents=True)
        (root / "proposal-validation.json").write_text(json.dumps({"status": "valid", "stage": "subhalo"}))
        (root / "stage-result.json").write_text(json.dumps({"stage": "subhalo", "attempt": number}))
    snapshot, reason = _retry_budget_snapshot(tmp_path, StageName.SUBHALO)
    assert snapshot == {"stage_used": 2, "stage_limit": 2}
    assert "exhausted" in reason


def test_manifest_includes_confirmed_preview_at_attempt_root(tmp_path):
    from lens_agent.stages import _write_artifact_manifest
    from lens_agent.adjudication import _artifact_gate_failure
    output, root = _eligible_attempt(tmp_path, "subhalo")
    (root / "preview-confirmed.json").write_text('{"inspected": true}')
    result_path = root / "stage-result.json"
    result = json.loads(result_path.read_text())
    result["artifacts"]["confirmed_preview"] = "preview-confirmed.json"
    result["metrics"] = {"delta_log_z": -0.5}
    result_path.write_text(json.dumps(result))
    assert _artifact_gate_failure(root, result) is not None
    _write_artifact_manifest(root, result["artifacts"])
    assert _artifact_gate_failure(root, result) is None
    response = tmp_path / "review.json"
    response.write_text(json.dumps(_review(False)))
    decision = json.loads(adjudicate_attempt(output, StageName.SUBHALO, 0, response=response).read_text())
    assert decision["decision"] == "accept"
    promote_attempt(output, StageName.SUBHALO, 0)
