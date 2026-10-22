import importlib.util
import json
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "skills/verify-citations/scripts/verifier.py"
sys.path.insert(0, str(SCRIPT.parent))
import model_review as mr
spec = importlib.util.spec_from_file_location("verifier", SCRIPT)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class EvidenceTests(unittest.TestCase):
    sentence = "Treatment reduced risk by 25% [1]."

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def record(self, row, judgment, stage):
        run_id = str(uuid.uuid4())
        folder = self.directory / run_id
        folder.mkdir()
        source = self.source()
        payload = [{"id": row["id"], "sentence": row["sentence"], "reference": row.get("reference", ""),
                    "source_title": source.get("title"), "source_identifier": source.get("identifier"),
                    "source_tier": source["tier"], "source_text": source["text"]}]
        prompt = mr.prompt_for(payload)
        judgment.setdefault("model", "fixture-model")
        judgment.setdefault("reason", "Fixture reasoning")
        judgment.setdefault("uncertain", False)
        answer = {"id": row["id"], **{k: judgment.get(k) for k in ["relation", "quote", "reason", "uncertain"]}}
        trace = "\n".join(json.dumps(event) for event in [
            {"type": "thread.started", "thread_id": run_id},
            {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps({"rows": [answer]})}},
            {"type": "turn.completed"}])
        (folder / "input.txt").write_text(prompt)
        (folder / "events.jsonl").write_text(trace)
        mr.write_json(folder / "receipt.json", {"runner": "codex_exec", "stage": stage, "run_id": run_id,
                      "thread_id": run_id, "status": "completed", "provider": "openai", "blind_to_other_pass": True,
                      "model_requested": judgment["model"], "input_sha256": mr.digest(prompt),
                      "events_sha256": mr.digest(trace)})
        judgment["execution_file"] = run_id + "/receipt.json"
        return judgment

    def finalize_row(self, row, manuscript, source):
        return v.finalize_row(row, manuscript, source, directory=self.directory)

    def source(self, tier="full_text"):
        return {"tier": tier, "text": "Treatment reduced risk by 25% in adults.",
                "url": "https://example.org/paper", "identifier": "test"}

    def row(self, **changes):
        row = {"id": "1:1", "sentence": self.sentence, "relation": "supports", "uncertain": False,
                "quote": "Treatment reduced risk by 25% in adults.",
                "second_pass": {"relation": "supports", "quote": "Treatment reduced risk by 25% in adults.",
                                "reason": "Magnitude and direction match.", "uncertain": False, "blind": False},
                "human_verdict": "accept", "human_notes": "Keep my review", **changes}
        self.record(row, row, "first")
        if isinstance(row.get("second_pass"), dict):
            self.record(row, row["second_pass"], "second")
        return row

    def test_real_quote_and_preserved_human_review(self):
        result = self.finalize_row(self.row(), self.sentence, self.source())
        self.assertEqual(result["verdict"], "supported")
        self.assertTrue(result["quote_verified"])
        self.assertEqual(result["human_verdict"], "accept")

    def test_fabricated_quote_never_supported(self):
        result = self.finalize_row(self.row(quote="Treatment cured everyone."), self.sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")
        self.assertIsNone(result["quote"])

    def test_fabricated_sentence_never_supported(self):
        result = self.finalize_row(self.row(), "Unrelated manuscript text.", self.source())
        self.assertEqual(result["verdict"], "flagged")

    def test_silence_depends_on_coverage(self):
        for tier, expected in [("abstract_only", "needs_full_text"), ("partial_text", "needs_full_text"),
                               ("full_text", "needs_review")]:
            with self.subTest(tier=tier):
                second = {"relation": "silent", "quote": None, "uncertain": False}
                result = self.finalize_row(self.row(relation="silent", quote=None, second_pass=second), self.sentence, self.source(tier))
                self.assertEqual(result["verdict"], expected)

    def test_magnitude_mismatch_flagged(self):
        sentence = self.sentence.replace("25%", "50%")
        result = self.finalize_row(self.row(sentence=sentence), sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")
        self.assertEqual(result["missing_numbers"], ["50%"])

    def test_contradiction_requires_evidence(self):
        result = self.finalize_row(self.row(relation="contradicts", quote="made up"), self.sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")

    def test_missing_source_unresolved(self):
        self.assertEqual(self.finalize_row(self.row(), self.sentence, None)["verdict"], "unresolved")

    def test_second_pass_required(self):
        result = self.finalize_row(self.row(second_pass=None), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_second_pass")

    def test_second_pass_disagreement(self):
        second = {"relation": "silent", "quote": None, "uncertain": False}
        result = self.finalize_row(self.row(second_pass=second), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_review")

    def test_second_pass_fabricated_evidence(self):
        second = {"relation": "supports", "quote": "Fabricated quote", "uncertain": False}
        result = self.finalize_row(self.row(second_pass=second), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_review")

    def test_second_pass_uncertainty(self):
        second = {"relation": "supports", "quote": self.source()["text"], "uncertain": True}
        result = self.finalize_row(self.row(second_pass=second), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_review")

    def test_abstract_fallback_after_full_text_failure(self):
        def fetch(url):
            if "fullTextXML" in url:
                raise OSError("not available")
            return json.dumps({"resultList": {"result": [{"title": "Test", "pmcid": "PMC123",
                                                        "abstractText": "<p>Abstract evidence.</p>"}]}}).encode()
        result = v.fetch_source("123", fetch)
        self.assertEqual(result["tier"], "abstract_only")
        self.assertEqual(result["text"], "Abstract evidence.")

    def test_full_text_retrieval(self):
        def fetch(url):
            if "fullTextXML" in url:
                return b"<article><front><article-title>Test</article-title></front><body><sec><p>Results.</p></sec></body></article>"
            return b'{"resultList":{"result":[{"pmcid":"PMC123"}]}}'
        result = v.fetch_source("123", fetch)
        self.assertEqual(result["tier"], "full_text")
        self.assertIn("Results.", result["text"])

    def test_docx_superscript(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paper.docx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>12</w:t></w:r></w:p></w:body></w:document>')
            self.assertEqual(v.extract(path), "Claim^{12}")

    def test_export_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "source.json").write_text(json.dumps(self.source()))
            manuscript = directory / "manuscript.txt"
            manuscript.write_text(self.sentence)
            draft = directory / "draft.json"
            row = self.row(source_file="source.json", reason="=HYPERLINK(bad)")
            draft.write_text(json.dumps([row]))
            v.finalize(draft, manuscript, directory / "report")
            self.assertIn("'=HYPERLINK", (directory / "report.csv").read_text())
            self.assertTrue((directory / "report.json").exists())
            draft.write_text(json.dumps([row, row]))
            with self.assertRaises(ValueError):
                v.finalize(draft, manuscript, directory / "report")

    def test_same_context_note_without_record_cannot_support(self):
        row = self.row()
        row["second_pass"].pop("execution_file")
        row["second_pass"]["blind"] = True  # A claimed flag alone is insufficient.
        self.assertEqual(self.finalize_row(row, self.sentence, self.source())["verdict"], "needs_second_pass")

    def test_changed_source_invalidates_record(self):
        source = self.source()
        source["text"] += " New context."
        self.assertEqual(self.finalize_row(self.row(), self.sentence, source)["verdict"], "needs_second_pass")

    def test_changed_judgment_invalidates_record(self):
        row = self.row()
        row["second_pass"]["reason"] = "I changed my reasoning after seeing the first pass."
        self.assertEqual(self.finalize_row(row, self.sentence, self.source())["verdict"], "needs_second_pass")

    def test_changed_trace_invalidates_record(self):
        row = self.row()
        receipt = self.directory / row["second_pass"]["execution_file"]
        (receipt.parent / "events.jsonl").write_text('{}\n')
        self.assertEqual(self.finalize_row(row, self.sentence, self.source())["verdict"], "needs_second_pass")

    def test_real_quote_and_context_survive_export(self):
        row = self.row(source_file="source.json")
        (self.directory / "source.json").write_text(json.dumps(self.source()))
        (self.directory / "manuscript.txt").write_text(self.sentence)
        (self.directory / "draft.json").write_text(json.dumps([row]))
        v.finalize(self.directory / "draft.json", self.directory / "manuscript.txt", self.directory / "report")
        report = json.loads((self.directory / "report.json").read_text())["rows"][0]
        self.assertEqual(report["verdict"], "supported")
        self.assertEqual(report["quote"], self.source()["text"])
        self.assertEqual(report["second_pass"]["quote"], self.source()["text"])
        self.assertIn(report["quote"], report["source_excerpt"])
        self.assertTrue(report["second_pass_blind"])
        self.assertIn(report["quote"], (self.directory / "report.csv").read_text())
        self.assertEqual(v.check_export(self.directory / "report.json")["status"], "passed")
        report["quote"] = None
        (self.directory / "stripped.json").write_text(json.dumps({"version": 2, "rows": [report]}))
        with self.assertRaisesRegex(ValueError, "missing inspectable evidence"):
            v.check_export(self.directory / "stripped.json")

    def test_tool_execution_rejected(self):
        trace = '\n'.join(json.dumps(x) for x in [
            {"type": "thread.started", "thread_id": "x"},
            {"type": "item.started", "item": {"type": "command_execution", "command": "cat draft.json"}}])
        with self.assertRaisesRegex(ValueError, "used a tool"):
            mr.parse_trace(trace)

    def test_prompt_contains_no_first_pass_judgment(self):
        row = self.row(source_file="source.json", reason="SECRET FIRST PASS")
        (self.directory / "source.json").write_text(json.dumps(self.source()))
        prompt = mr.prompt_for(mr.payload_for([row], self.directory))
        self.assertNotIn("SECRET FIRST PASS", prompt)
        self.assertNotIn("second_pass", prompt)
        self.assertNotIn("execution_file", prompt)

    def test_model_failure_cannot_be_recorded_as_success(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        row = self.row(source_file="source.json")
        row.pop("second_pass", None)  # Exercise failure on a pending stage, not replacement.
        (self.directory / "source.json").write_text(json.dumps(self.source()))
        (self.directory / "draft.json").write_text(json.dumps([row]))
        with patch.object(mr.shutil, "which", return_value="/fixture/codex"):
            with self.assertRaisesRegex(ValueError, "failed"):
                mr.run_review(self.directory / "draft.json", self.directory / "out.json", "second", "fixture-model",
                              run_impl=lambda *a, **kw: SimpleNamespace(returncode=1, stdout="", stderr="not available"))
        self.assertFalse((self.directory / "out.json").exists())

    def test_five_claim_two_session_pipeline_fixture(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        samples = [
            ("Treatment reduced risk by 25% [1].", "Treatment reduced risk by 25%.", "supports"),
            ("Treatment reduced risk by 50% [2].", "Treatment reduced risk by 25%, not 50%.", "contradicts"),
            ("Treatment improves sleep [3].", "This abstract reports blood pressure only.", "silent"),
            ("This was a randomized study [4].", "This was a single-arm nonrandomized study.", "contradicts"),
            ("Treatment improved blood pressure [5].", "Treatment improved blood pressure.", "supports")]
        rows, answers = [], []
        for n, (sentence, source_text, relation) in enumerate(samples, 1):
            mr.write_json(self.directory / f"source-{n}.json", {"text": source_text,
                          "tier": "abstract_only" if n == 3 else "full_text", "identifier": f"fixture-{n}"})
            rows.append({"id": str(n), "sentence": sentence, "source_file": f"source-{n}.json",
                         "human_verdict": None, "human_notes": "Preserve this note"})
            answers.append({"id": str(n), "relation": relation, "quote": None if relation == "silent" else source_text,
                            "reason": "Synthetic fixture judgment; not a live model result.", "uncertain": False})
        mr.write_json(self.directory / "draft.json", rows)
        (self.directory / "manuscript.txt").write_text('\n'.join(r["sentence"] for r in rows))
        seen_inputs = []
        def fake_call(command, **kwargs):
            seen_inputs.append(kwargs["input"])
            self.assertIn("--ephemeral", command)
            self.assertIn("--ignore-user-config", command)
            self.assertEqual(list(Path(kwargs["cwd"]).iterdir()), [])
            trace = '\n'.join(json.dumps(event) for event in [
                {"type": "thread.started", "thread_id": str(uuid.uuid4())},
                {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps({"rows": answers})}},
                {"type": "turn.completed"}])
            return SimpleNamespace(returncode=0, stdout=trace, stderr="")
        with patch.object(mr.shutil, "which", return_value="/fixture/codex"):
            mr.run_review(self.directory / "draft.json", self.directory / "first.json", "first", "fixture-model", run_impl=fake_call)
            mr.run_review(self.directory / "first.json", self.directory / "second.json", "second", "fixture-model", run_impl=fake_call)
        self.assertEqual(seen_inputs[0], seen_inputs[1])
        results = v.finalize(self.directory / "second.json", self.directory / "manuscript.txt", self.directory / "report")
        self.assertEqual([r["verdict"] for r in results], ["supported", "not_supported", "needs_full_text", "not_supported", "supported"])
        self.assertTrue(all(r["human_notes"] == "Preserve this note" for r in results))
        self.assertEqual(v.check_export(self.directory / "report.json")["rows"], 5)

    def test_old_compact_export_rejected(self):
        path = self.directory / "old.json"
        path.write_text(json.dumps({"summary": {}, "rows": [{"verdict": "supported", "quote_verified": True}]}))
        with self.assertRaisesRegex(ValueError, "version 2"):
            v.check_export(path)


if __name__ == "__main__":
    unittest.main()
