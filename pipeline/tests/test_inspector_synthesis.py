import json
from pathlib import Path

import pytest

from lens_agent.cli import main
from tests.helpers import make_lens_dir, model_inspector_decision


def _write_json(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")
    return path


def _prepare_run(tmp_path: Path) -> tuple[Path, Path]:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    return lens_dir, output_dir


def _record_votes(
    tmp_path: Path, output_dir: Path, votes: list[dict[str, object]]
) -> list[Path]:
    responses = [
        _write_json(tmp_path / f"vote-{index}.json", vote)
        for index, vote in enumerate(votes)
    ]
    main(
        [
            "inspector",
            "votes",
            "--output-dir",
            str(output_dir),
            *[
                item
                for response in responses
                for item in ("--response", str(response))
            ],
        ]
    )
    return responses


def test_three_valid_inspector_votes_are_recorded_together(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    votes = []
    for index in range(3):
        decision = model_inspector_decision(lens_dir.name)
        decision["reason"] = f"independent inspection {index}"
        votes.append(decision)
    responses = _record_votes(tmp_path, output_dir, votes)

    vote_dir = output_dir / "preflight" / "inspector-votes"
    assert [
        json.loads((vote_dir / f"{index}.json").read_text(encoding="utf-8"))
        for index in range(3)
    ] == [json.loads(path.read_text(encoding="utf-8")) for path in responses]


def test_valid_majority_synthesis_is_recorded(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    vote_values = [
        model_inspector_decision(lens_dir.name, estimate_arcsec=1.2),
        model_inspector_decision(lens_dir.name, estimate_arcsec=1.4),
        {
            "lens_id": lens_dir.name,
            "disposition": "human_review",
            "contaminant_ids": [1, 2],
            "reason": "possible second deflector",
            "theta_E_hint": None,
        },
    ]
    vote_values[0]["contaminant_ids"] = [1, 2]
    vote_values[1]["contaminant_ids"] = [1, 3]
    _record_votes(tmp_path, output_dir, vote_values)
    synthesis = model_inspector_decision(lens_dir.name, estimate_arcsec=1.4)
    synthesis["contaminant_ids"] = [1, 2]
    synthesis["reason"] = "Two of three inspectors support simple modeling."
    response = _write_json(tmp_path / "synthesis-response.json", synthesis)

    main(
        [
            "inspector",
            "synthesis",
            "--output-dir",
            str(output_dir),
            "--response",
            str(response),
        ]
    )

    assert json.loads(
        (output_dir / "preflight" / "synthesis.json").read_text(encoding="utf-8")
    ) == synthesis


def test_one_invalid_response_prevents_the_complete_vote_set(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    responses = []
    for index in range(3):
        decision = model_inspector_decision(lens_dir.name)
        if index == 2:
            decision["theta_E_hint"] = None
        responses.append(_write_json(tmp_path / f"vote-{index}.json", decision))

    with pytest.raises(ValueError, match=r"(?s)vote-2\.json.*requires theta_E_hint"):
        main(
            [
                "inspector",
                "votes",
                "--output-dir",
                str(output_dir),
                *[
                    item
                    for response in responses
                    for item in ("--response", str(response))
                ],
            ]
        )

    assert not (output_dir / "preflight" / "inspector-votes").exists()


def test_synthesis_rejects_minority_disposition_and_single_vote_id(
    tmp_path: Path,
) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    votes = [model_inspector_decision(lens_dir.name) for _ in range(3)]
    votes[0]["contaminant_ids"] = [1, 9]
    votes[1]["contaminant_ids"] = [1]
    _record_votes(tmp_path, output_dir, votes)
    minority = {
        "lens_id": lens_dir.name,
        "disposition": "human_review",
        "contaminant_ids": [1, 9],
        "reason": "minority synthesis",
        "theta_E_hint": None,
    }
    response = _write_json(tmp_path / "synthesis-response.json", minority)

    with pytest.raises(ValueError, match="disposition.*two-of-three"):
        main(
            [
                "inspector",
                "synthesis",
                "--output-dir",
                str(output_dir),
                "--response",
                str(response),
            ]
        )

    minority["disposition"] = "model"
    minority["theta_E_hint"] = votes[0]["theta_E_hint"]
    _write_json(response, minority)
    with pytest.raises(ValueError, match="contaminant_ids.*two-of-three"):
        main(
            [
                "inspector",
                "synthesis",
                "--output-dir",
                str(output_dir),
                "--response",
                str(response),
            ]
        )

    assert not (output_dir / "preflight" / "synthesis.json").exists()


def test_model_synthesis_rejects_a_spliced_theta_e_hint(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    votes = [
        model_inspector_decision(lens_dir.name, estimate_arcsec=estimate)
        for estimate in (1.1, 1.5, 1.8)
    ]
    _record_votes(tmp_path, output_dir, votes)
    synthesis = model_inspector_decision(lens_dir.name, estimate_arcsec=1.5)
    synthesis["theta_E_hint"]["confidence"] = "low"
    response = _write_json(tmp_path / "synthesis-response.json", synthesis)

    with pytest.raises(ValueError, match="exactly match one majority model vote"):
        main(
            [
                "inspector",
                "synthesis",
                "--output-dir",
                str(output_dir),
                "--response",
                str(response),
            ]
        )


def test_human_review_synthesis_requires_null_hint(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    human_votes = [
        {
            "lens_id": lens_dir.name,
            "disposition": "human_review",
            "contaminant_ids": [],
            "reason": f"complex morphology {index}",
            "theta_E_hint": None,
        }
        for index in range(2)
    ]
    votes = [*human_votes, model_inspector_decision(lens_dir.name)]
    _record_votes(tmp_path, output_dir, votes)
    synthesis = {
        "lens_id": lens_dir.name,
        "disposition": "human_review",
        "contaminant_ids": [],
        "reason": "Two reports find complex morphology.",
        "theta_E_hint": votes[2]["theta_E_hint"],
    }
    response = _write_json(tmp_path / "synthesis-response.json", synthesis)

    with pytest.raises(ValueError, match="requires theta_E_hint to be null"):
        main(
            [
                "inspector",
                "synthesis",
                "--output-dir",
                str(output_dir),
                "--response",
                str(response),
            ]
        )

    synthesis["theta_E_hint"] = None
    _write_json(response, synthesis)
    main(
        [
            "inspector",
            "synthesis",
            "--output-dir",
            str(output_dir),
            "--response",
            str(response),
        ]
    )
    assert json.loads(
        (output_dir / "preflight" / "synthesis.json").read_text(encoding="utf-8")
    ) == synthesis


def test_valid_synthesis_remains_the_only_input_to_canonical_masking(
    tmp_path: Path,
) -> None:
    lens_dir, output_dir = _prepare_run(tmp_path)
    votes = [model_inspector_decision(lens_dir.name) for _ in range(3)]
    _record_votes(tmp_path, output_dir, votes)
    synthesis = model_inspector_decision(lens_dir.name)
    synthesis["reason"] = "All three reports support a simple lens."
    response = _write_json(tmp_path / "synthesis-response.json", synthesis)
    main(
        [
            "inspector",
            "synthesis",
            "--output-dir",
            str(output_dir),
            "--response",
            str(response),
        ]
    )

    main(
        [
            "mask",
            "--output-dir",
            str(output_dir),
            "--inspection",
            str(output_dir / "preflight" / "synthesis.json"),
        ]
    )

    assert json.loads(
        (output_dir / "preflight" / "inspector.json").read_text(encoding="utf-8")
    ) == synthesis
    assert (output_dir / "preflight" / "modeling_mask.fits").is_file()
