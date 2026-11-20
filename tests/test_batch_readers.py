import json
import runpy
import tempfile
import unittest
from pathlib import Path


SERVER = Path(__file__).resolve().parents[1] / "server"
preview = runpy.run_path(str(SERVER / "read-batch-plan.py"))["plan"]
stage_scope = runpy.run_path(str(SERVER / "read-stage-scope.py"))["scope"]


class BatchReaders(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = self.root / "pipeline"
        self.input_dir = self.root / "input"
        self.output_dir = self.workspace / "output" / "batch"
        self.workspace.mkdir()
        self.input_dir.mkdir()
        self.request = {"workspace": str(self.workspace), "inputDir": str(self.input_dir), "outputDir": str(self.output_dir)}

    def write_input(self, name):
        lens = self.input_dir / name
        lens.mkdir()
        (lens / f"{name}.fits").touch()
        return lens

    def write_manifest(self, lens):
        run = self.output_dir / lens.name
        run.mkdir(parents=True)
        (run / "run-manifest.json").write_text(json.dumps({"schema_version": "lens_run_manifest.v1", "lens_dir": str(lens), "run_id": "demo-run"}))
        return run

    def test_prefix_and_lexical_count_are_read_only(self):
        for lens_id in ("hst-10", "hst-02", "hst-01", "euclid-01"):
            self.write_input(lens_id)
        (self.input_dir / "hst-00").mkdir()
        plan = preview({**self.request, "selection": {"count": 2, "prefix": "hst-"}})
        self.assertEqual([target["lensId"] for target in plan["targets"]], ["hst-01", "hst-02"])
        self.assertFalse(self.output_dir.exists())
        with self.assertRaisesRegex(ValueError, "少于"):
            preview({**self.request, "selection": {"count": 4, "prefix": "hst-"}})

    def test_preview_binds_existing_run_and_rejects_a_mismatched_manifest(self):
        lens = self.write_input("hst-01")
        run = self.write_manifest(lens)
        request = {**self.request, "selection": {"ids": [lens.name]}}
        self.assertEqual(preview(request)["targets"][0]["runId"], "demo-run")
        manifest = run / "run-manifest.json"
        record = json.loads(manifest.read_text())
        manifest.write_text(json.dumps({**record, "lens_dir": "/another/input/hst-01"}))
        with self.assertRaisesRegex(ValueError, "不一致"):
            preview(request)

    def test_human_review_requires_the_saved_decision_for_the_reported_attempt(self):
        lens = self.write_input("hst-07")
        run = self.write_manifest(lens)
        decision = run / "attempts/m2/1/decision.json"
        decision.parent.mkdir(parents=True)
        value = {"schema_version": "stage_decision.v1", "stage": "m2", "attempt": 1, "decision": "human_review"}
        decision.write_text(json.dumps(value))
        request = {"root": str(self.workspace), "storage": str(run), "lens_id": lens.name, "input_lens": str(lens),
                   "stage": "m2", "attempt": 1, "accepted": False, "human_review": True}
        self.assertEqual(stage_scope(request), {"run_id": "demo-run", "attempt": 1})
        with self.assertRaisesRegex(ValueError, "input directory"):
            stage_scope({**request, "input_lens": "/another/input/hst-07"})
        decision.write_text(json.dumps({**value, "decision": "retry"}))
        with self.assertRaisesRegex(ValueError, "Human Review"):
            stage_scope(request)
