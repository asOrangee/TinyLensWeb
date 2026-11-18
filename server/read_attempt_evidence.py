"""Validate the frozen file identities in one reported stage decision."""
import hashlib
import json


def decision_evidence(raw, stage, attempt):
    decision = json.loads(raw)
    if not isinstance(decision, dict) or type(decision.get("attempt")) is not int or (
        decision.get("schema_version"), decision.get("stage"), decision.get("attempt")
    ) != (
        "stage_decision.v1", stage, attempt
    ) or not isinstance(decision.get("evidence_sha256"), dict):
        raise ValueError("The reported decision does not identify this attempt")
    return decision["evidence_sha256"]


def verify_decision_file(evidence, name, raw):
    if evidence.get(name) != hashlib.sha256(raw).hexdigest():
        raise ValueError("The reported decision does not bind " + name)
    return raw
