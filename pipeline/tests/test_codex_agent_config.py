import json
import tomllib
from pathlib import Path

from jsonschema import Draft202012Validator

from lens_agent.configuration import TUNABLE_CATALOG
from lens_agent.evaluation.stage_expert_schemas import render_review_vocabulary


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = REPOSITORY_ROOT / ".codex" / "evals"
AGENT_DIR = REPOSITORY_ROOT / ".codex" / "agents"
GLOSSARY_PATH = (
    ".codex/skills/lens-model-orchestrator/references/stage-review-glossary.md"
)
GLOSSARY_FILE = REPOSITORY_ROOT / GLOSSARY_PATH

EXPERTS = {
    "a": "stage-a-expert",
    "b": "stage-b-expert",
    "m0": "stage-m0-expert",
    "m1": "stage-m1-expert",
    "m2": "stage-m2-expert",
    "m3": "stage-m3-expert",
}

def _schema(stage: str) -> dict:
    return json.loads(
        (EVAL_DIR / f"stage-{stage}-expert-output.schema.json").read_text(
            encoding="utf-8"
        )
    )


def test_stage_experts_are_independent_write_capable_roles() -> None:
    config = tomllib.loads(
        (REPOSITORY_ROOT / ".codex" / "config.toml").read_text(encoding="utf-8")
    )
    assert all(f"stage_{stage}_expert" not in config["agents"] for stage in EXPERTS)
    assert not (AGENT_DIR / "stage-reviewer.toml").exists()
    assert not (AGENT_DIR / "arc-mask-expert.toml").exists()

    manual = (
        REPOSITORY_ROOT
        / ".codex"
        / "skills"
        / "lens-model-orchestrator"
        / "references"
        / "stage-expert-loop.md"
    ).read_text(encoding="utf-8")
    normalized_manual = " ".join(manual.split())
    for stage, filename in EXPERTS.items():
        definition = tomllib.loads(
            (AGENT_DIR / f"{filename}.toml").read_text(encoding="utf-8")
        )
        assert definition["name"] == f"stage_{stage}_expert"
        assert definition["sandbox_mode"] == "danger-full-access"
        assert "stage-expert-loop.md" in definition["developer_instructions"]
        assert GLOSSARY_PATH in definition["developer_instructions"]
        assert f"stage-{stage}-expert-output.schema.json" in definition[
            "developer_instructions"
        ]
        schema = _schema(stage)
        assert GLOSSARY_PATH in schema["description"]
    assert "Use the exact absolute `Lens Agent Command` supplied" in normalized_manual
    assert "for every non-stage operation" in normalized_manual
    assert "Use the exact absolute `GPU Stage Command` supplied" in manual
    assert "Resource allocation belongs to the GPU Stage Runner" in normalized_manual
    assert "<GPU Stage Command> --" in manual
    assert "Never resolve or run a bare `lens-agent` or `python` command" in normalized_manual
    assert "Never edit Python" in manual
    assert "development_recommendation" in manual

    inspector = tomllib.loads(
        (AGENT_DIR / "system-inspector.toml").read_text(encoding="utf-8")
    )
    assert inspector["sandbox_mode"] == "read-only"


def test_orchestrator_delegates_every_physical_stage_loop() -> None:
    orchestrator = (
        REPOSITORY_ROOT / ".codex" / "skills" / "lens-model-orchestrator" / "SKILL.md"
    ).read_text(encoding="utf-8")
    normalized = " ".join(orchestrator.split())
    for stage in EXPERTS:
        assert f"`stage_{stage}_expert`" in orchestrator
    assert "never reviews A, B, M0, M1, M2, or M3 evidence" in normalized
    assert "M0 has no AI expert" not in orchestrator
    assert "every prepare, execute, review, adjudicate, retry, promote, and resume detail" in normalized
    assert "accepted/<stage>.json" in orchestrator
    assert "the exact absolute `Lens Agent Command`" in orchestrator
    assert "the exact absolute `GPU Stage Command`" in orchestrator
    assert "Full Lens Rerun" in orchestrator
    assert "<Lens Agent Command> rerun prepare" in orchestrator
    assert "the exact absolute `GPU Stage Command`" in orchestrator
    assert "inspector_prompt_png" in orchestrator
    assert "never the separate" in normalized


def test_orchestrator_runs_three_inspections_then_text_only_synthesis() -> None:
    orchestrator = (
        REPOSITORY_ROOT / ".codex" / "skills" / "lens-model-orchestrator" / "SKILL.md"
    ).read_text(encoding="utf-8")
    normalized = " ".join(orchestrator.split())

    assert "three independent `system_inspector` agents in parallel" in normalized
    assert "cannot see either of the other responses" in normalized
    assert "<Lens Agent Command> inspector votes" in normalized
    assert "close all three System Inspectors" in normalized
    assert "one `preflight_synthesis_expert`" in normalized
    assert "only the exact `lens_id` and the three canonical vote paths" in normalized
    assert "never give it either preflight image" in normalized
    assert "<Lens Agent Command> inspector synthesis" in normalized
    assert "preflight/synthesis.json" in normalized
    assert "rerun all three inspections and synthesis" in normalized


def test_lens_run_agents_require_english_for_all_natural_language_outputs() -> None:
    repository_policy = (REPOSITORY_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    orchestrator = (
        REPOSITORY_ROOT / ".codex" / "skills" / "lens-model-orchestrator" / "SKILL.md"
    ).read_text(encoding="utf-8")
    stage_expert_manual = (
        REPOSITORY_ROOT
        / ".codex"
        / "skills"
        / "lens-model-orchestrator"
        / "references"
        / "stage-expert-loop.md"
    ).read_text(encoding="utf-8")
    inspector = tomllib.loads(
        (AGENT_DIR / "system-inspector.toml").read_text(encoding="utf-8")
    )["developer_instructions"]
    synthesis = tomllib.loads(
        (AGENT_DIR / "preflight-synthesis-expert.toml").read_text(encoding="utf-8")
    )["developer_instructions"]

    normalized_policy = " ".join(repository_policy.split())
    assert "During a Lens Run, use English only" in normalized_policy
    assert "user-facing and inter-agent" in normalized_policy
    assert "agent-generated natural-language fields" in normalized_policy

    normalized_orchestrator = " ".join(orchestrator.split())
    assert "Use English only for every Lens Orchestrator message" in (
        normalized_orchestrator
    )
    assert "delegation tasks, corrections, progress updates" in normalized_orchestrator
    assert "final Markdown summary" in normalized_orchestrator

    normalized_manual = " ".join(stage_expert_manual.split())
    assert "Use concise scientific English for every Stage Expert message" in (
        normalized_manual
    )
    assert "every agent-authored natural-language field" in normalized_manual

    normalized_inspector = " ".join(inspector.split())
    assert "Use concise scientific English for all agent-authored text" in (
        normalized_inspector
    )
    assert "`reason` and `theta_E_hint.basis`" in normalized_inspector

    normalized_synthesis = " ".join(synthesis.split())
    assert "Use concise scientific English for every agent-authored string" in (
        normalized_synthesis
    )


def test_each_non_b_expert_schema_has_only_its_stage_vocabulary_and_tunables() -> None:
    for stage in ("a", "m1", "m2", "m3"):
        schema = _schema(stage)
        assert schema["additionalProperties"] is False
        assert schema["properties"]["stage"] == {"const": stage}
        assert schema == render_review_vocabulary(schema, stage)
        assert "development_recommendation" in schema["required"]
        branches = schema["$defs"]["proposal"]["oneOf"]
        schema_parameters = {
            parameter
            for branch in branches
            for parameter in (
                [branch["properties"]["parameter"]["const"]]
                if "const" in branch["properties"]["parameter"]
                else branch["properties"]["parameter"]["enum"]
            )
        }
        catalog_parameters = {
            name for name, spec in TUNABLE_CATALOG.items() if spec.stage == stage
        }
        assert schema_parameters == catalog_parameters
        assert all(branch["x-role"] == f"stage_{stage}_expert" for branch in branches)
        assert all(
            "stage" not in branch["if"].get("properties", {})
            for branch in schema["allOf"]
        )
        assert len(schema["allOf"]) == (2 if stage == "m2" else 1)


def test_m0_expert_has_a_dedicated_grid_only_contract() -> None:
    schema = _schema("m0")
    assert schema["additionalProperties"] is False
    assert schema["properties"]["stage"] == {"const": "m0"}
    assert schema["properties"]["grid_judgment"]["enum"] == [
        "grid_sufficient", "source_bbox_truncation", "indeterminate",
    ]
    assert "retry_repair" not in schema["properties"]
    assert "progression_blockers" not in schema["properties"]
    instructions = tomllib.loads(
        (AGENT_DIR / "stage-m0-expert.toml").read_text(encoding="utf-8")
    )["developer_instructions"]
    assert "Review only Source Grid Sufficiency" in instructions
    assert "Never choose a grid size" in instructions


def test_m0_expert_golden_cases_cover_grid_only_judgments() -> None:
    manifest = tomllib.loads(
        (EVAL_DIR / "stage-m0-expert-golden.toml").read_text(encoding="utf-8")
    )
    fixtures = json.loads(
        (EVAL_DIR / "stage-m0-expert-contract-cases.json").read_text(
            encoding="utf-8"
        )
    )
    expected = {
        case["name"]: case["expected_grid_judgment"]
        for case in manifest["cases"]
    }
    assert set(expected.values()) == {
        "grid_sufficient", "source_bbox_truncation", "indeterminate",
    }
    assert {case["name"] for case in fixtures["cases"]} == set(expected)
    for case in fixtures["cases"]:
        review = case["review"]
        Draft202012Validator(_schema("m0")).validate(review)
        assert review["grid_judgment"] == expected[case["name"]]

def test_mass_and_regularization_pathologies_are_stage_specific() -> None:
    expected_blockers = {
        "a": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
        ),
        "m1": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
            "pathological_source_reconstruction",
            "source_bbox_truncation",
            "unsupported_stage_drift",
        ),
        "m2": (
            "material_prior_truncation",
            "sampling_pathology",
            "regularization_pathology",
        ),
        "m3": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
            "pathological_source_reconstruction",
            "source_bbox_truncation",
            "unsupported_stage_drift",
        ),
    }
    for stage, blockers in expected_blockers.items():
        assert tuple(_schema(stage)["$defs"]["blocker_kind"]["enum"]) == blockers



def test_glossary_defines_every_closed_scientific_review_term() -> None:
    glossary = GLOSSARY_FILE.read_text(encoding="utf-8")
    vocabulary = {
        term
        for stage in ("a", "m1", "m2", "m3")
        for term in (
            *_schema(stage)["$defs"]["blocker_kind"]["enum"],
            *_schema(stage)["properties"]["handoff_warnings"]["items"]["properties"][
                "kind"
            ]["enum"],
        )
    }
    for term in vocabulary:
        assert f"### `{term}`" in glossary


def test_stage_b_schema_derives_decision_from_refinement_kind() -> None:
    schema = _schema("b")
    assert "decision" not in schema["properties"]
    assert "decision" not in schema["required"]
    assert "upstream_warning_updates" in schema["required"]
    Draft202012Validator(schema).validate(
        {
            "stage": "b",
            "refinement_kind": "selection",
            "predicted_image_dispositions": [
                {
                    "image_id": "image_1",
                    "disposition": "covered_consistent",
                    "evidence": ["the nearest pixel is covered"],
                },
                {
                    "image_id": "image_2",
                    "disposition": "covered_consistent",
                    "evidence": ["the nearest pixel is covered"],
                },
            ],
            "upstream_warning_updates": [],
            "retry_repair": None,
            "component_selection": {
                "component_catalog": "attempts/b/0/artifacts/stage_b_components.json",
                "drop_component_ids": [2],
            },
            "development_recommendation": None,
            "reason": "drop one unrelated complete component",
        }
    )
    branches = schema["properties"]["retry_repair"]["oneOf"][1]["properties"][
        "proposal"
    ]["oneOf"]
    assert all(branch["x-role"] == "stage_b_expert" for branch in branches)


def test_stage_expert_golden_manifests_cover_every_outcome() -> None:
    all_cases: dict[str, dict] = {}
    for stage in ("a", "m1", "m2", "m3"):
        manifest = tomllib.loads(
            (EVAL_DIR / f"stage-{stage}-expert-golden.toml").read_text(
                encoding="utf-8"
            )
        )
        assert manifest["schema_version"] == "stage_expert_golden.v1"
        assert manifest["agent_config"] == f"../agents/stage-{stage}-expert.toml"
        assert manifest["output_schema"] == f"stage-{stage}-expert-output.schema.json"
        assert {case["expected_decision"] for case in manifest["cases"]} == {
            "accept",
            "retry",
            "human_review",
        }
        all_cases.update({case["name"]: case for case in manifest["cases"]})

    fixtures = json.loads(
        (EVAL_DIR / "stage-expert-contract-cases.json").read_text(encoding="utf-8")
    )
    assert fixtures["schema_version"] == "stage_expert_contract.v1"
    assert {case["name"] for case in fixtures["cases"]} == set(all_cases)
    for case in fixtures["cases"]:
        review = case["review"]
        Draft202012Validator(_schema(review["stage"])).validate(review)
        expected = all_cases[case["name"]]
        assert [item["kind"] for item in review["progression_blockers"]] == expected[
            "expected_blockers"
        ]
        assert [item["kind"] for item in review["handoff_warnings"]] == expected[
            "expected_warnings"
        ]
        repair = review["retry_repair"]
        assert (repair["proposal"]["parameter"] if repair else "") == expected[
            "repair_target"
        ]


def test_decision_fixture_still_covers_the_deterministic_branches() -> None:
    fixture = json.loads(
        (EVAL_DIR / "stage-review-decision-cases.json").read_text(encoding="utf-8")
    )
    cases = {case["name"]: case["expected"] for case in fixture["cases"]}
    assert cases["hard_gate_failure"] == {
        "decision": "human_review",
        "reason_kind": "operational_failure",
    }
    assert cases["eligible_without_blockers"]["decision"] == "accept"
    assert cases["repairable_blocker"]["decision"] == "retry"
    assert cases["unrepairable_blocker"]["decision"] == "human_review"
    assert cases["exhausted_budget"]["decision"] == "human_review"


def test_stage_a_expert_uses_the_gpu_stage_runner_timeout_protocol() -> None:
    instructions = tomllib.loads(
        (AGENT_DIR / "stage-a-expert.toml").read_text(encoding="utf-8")
    )["developer_instructions"]
    normalized = " ".join(instructions.split())
    assert "1800-second wall-clock limit" in normalized
    assert "<GPU Stage Command> --timeout-seconds 1800 --" in normalized
    assert "acquires the GPU before starting the 1800-second controller" in normalized
    assert "wait for its job to reach a terminal state" in normalized
    assert "exit 124" in normalized
    assert "exit 137 only when this controller reached its 1800-second deadline" in normalized
    assert "exit 137 without that controller evidence as `incomplete_stage_execution`" in normalized
    assert "--failure stage_a_timeout" in instructions
    assert "Never review or rerun that attempt" in normalized


def test_stage_a_expert_preserves_scientific_review_policy() -> None:
    instructions = tomllib.loads(
        (AGENT_DIR / "stage-a-expert.toml").read_text(encoding="utf-8")
    )["developer_instructions"]
    normalized = " ".join(instructions.split())

    assert "Audit image-family correspondence" in normalized
    assert "fallible hypothesis derived from the same imaging data" in normalized
    assert "correlated evidence" in normalized
    assert "bounded evidence, including Stage-A diagnostics" in normalized
    assert "Unresolved correspondence is material and blocking" in normalized
    assert "two observation-supported assignments cannot coexist" in normalized
    assert "posterior as a compensation check, not a mechanical gate" in normalized
    assert "source plane is also not independent support" in normalized
    assert "Use `visual_prior_conflict` only for posterior disagreement" in normalized
    assert "Nuisance prior contact remains a warning unless" in normalized
    assert "accept with warnings" in normalized
    assert "they repair only `sampling_pathology`" in normalized
    assert "return `retry_repair: null`" in normalized


def test_system_inspector_schema_requires_hint_for_model_but_not_human_review() -> None:
    schema = json.loads(
        (EVAL_DIR / "system-inspector-output.schema.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema)
    model_without_hint = {
        "lens_id": "lens-001",
        "disposition": "model",
        "contaminant_ids": [],
        "reason": "one coherent simple lens",
        "theta_E_hint": None,
    }
    human_review = {
        "lens_id": "lens-001",
        "disposition": "human_review",
        "contaminant_ids": [],
        "reason": "two incompatible deflectors",
        "theta_E_hint": None,
    }
    assert list(validator.iter_errors(model_without_hint))
    assert not list(validator.iter_errors(human_review))


def test_preflight_synthesis_expert_is_text_only_and_majority_bound() -> None:
    config = tomllib.loads(
        (AGENT_DIR / "preflight-synthesis-expert.toml").read_text(encoding="utf-8")
    )
    instructions = " ".join(config["developer_instructions"].split())

    assert config["name"] == "preflight_synthesis_expert"
    assert isinstance(config["model"], str) and config["model"].strip()
    assert config["model_reasoning_effort"] in {"minimal", "low", "medium", "high", "xhigh", "max"}
    assert config["sandbox_mode"] == "read-only"
    assert "exactly three System Inspector Vote JSON files" in instructions
    assert "Do not inspect the preflight image" in instructions
    assert "must follow the two-of-three majority" in instructions
    assert "at least two votes contain that ID" in instructions
    assert "reported by only one vote" in instructions
    assert "exactly match one complete `theta_E_hint`" in instructions
    assert "For `human_review`, return `theta_E_hint: null`" in instructions
    assert "system-inspector-output.schema.json" in instructions
    assert "strict JSON only" in instructions


def test_system_inspector_uses_unified_four_stage_policy() -> None:
    config = tomllib.loads(
        (AGENT_DIR / "system-inspector.toml").read_text(encoding="utf-8")
    )
    instructions = config["developer_instructions"]
    normalized = " ".join(instructions.split())

    assert isinstance(config["model"], str) and config["model"].strip()
    assert config["model_reasoning_effort"] in {"minimal", "low", "medium", "high", "xhigh", "max"}
    assert (
        "You are an expert in astronomy and strong gravitational lensing. "
        "You are reviewing a **confirmed** Euclid strong-lens preflight "
        "two-panel visual-check image. This attached two-panel image is your "
        "only visual evidence."
    ) in normalized
    assert "Inspect only the left panel without segmentation contours" in normalized
    assert (
        "Do not refer to the segmentation boundaries, IDs, or object decomposition "
        "in the right panel"
    ) in normalized
    assert "faint lensed multiple images or arcs" in normalized
    assert "Jointly assess geometric position, morphology, and colour" in normalized
    assert (
        "Treat every segmentation in the right panel that does not cover the "
        "lens-galaxy or lensed-image positions as a contaminant region to be masked"
    ) in normalized
    assert "Return the IDs of these contaminant regions" in normalized
    assert (
        "If the system contains only one lens galaxy and the contaminants can be "
        "masked, set `disposition` to `\"model\"`"
    ) in normalized
    assert (
        "Otherwise set `disposition` to `\"human_review\"`; the system must not "
        "proceed to subsequent automated physical modelling"
    ) in normalized
    assert (
        "roughly estimate the Einstein radius as `theta_E_hint` in arcsec and "
        "give its plausible range as `plausible_range_arcsec`"
    ) in normalized
    assert (
        "exactly these five fields: `lens_id`, `disposition`, `contaminant_ids`, "
        "`reason`, and `theta_E_hint`"
    ) in normalized
    assert (
        "Use `reason` for the concise decision rationale and the approximate "
        "lens-galaxy and lensed-image coordinates"
    ) in normalized
    assert (
        "For `disposition: \"model\"`, `theta_E_hint` must be a complete object"
    ) in normalized
    assert "Boundary-Crossing Segment" not in normalized


def test_system_inspector_golden_cases_are_well_formed() -> None:
    golden = tomllib.loads(
        (EVAL_DIR / "system-inspector-golden.toml").read_text(encoding="utf-8")
    )
    assert golden["schema_version"] == "system_inspector_golden.v4"
    assert "model" not in golden
    assert "model_reasoning_effort" not in golden
    assert golden["cases"]
    assert len(golden["cases"]) == 18
    for case in golden["cases"]:
        assert case["image"].endswith("_2panel.png")
        assert len(case["image_sha256"]) == 64
        assert case["expected_disposition"] in {"model", "human_review"}
        assert case["expected_contaminant_ids"] == sorted(
            set(case["expected_contaminant_ids"])
        )
        assert all("boundary-crossing" not in item for item in case["focus"])
        assert all("boundary rule" not in item for item in case["focus"])
