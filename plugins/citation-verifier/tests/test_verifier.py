import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "skills/verify-citations/scripts/verifier.py"
spec = importlib.util.spec_from_file_location("verifier", SCRIPT)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class EvidenceTests(unittest.TestCase):
    sentence = "Treatment reduced risk by 25% [1]."

    def source(self, tier="full_text"):
        return {"tier": tier, "text": "Treatment reduced risk by 25% in adults.",
                "url": "https://example.org/paper", "identifier": "test"}

    def row(self, **changes):
        return {"id": "1:1", "sentence": self.sentence, "relation": "supports",
                "quote": "Treatment reduced risk by 25% in adults.",
                "second_pass": {"relation": "supports", "quote": "Treatment reduced risk by 25% in adults.",
                                "reason": "Magnitude and direction match.", "uncertain": False, "blind": False},
                "human_verdict": "accept", "human_notes": "Keep my review", **changes}

    def test_real_quote_and_preserved_human_review(self):
        result = v.finalize_row(self.row(), self.sentence, self.source())
        self.assertEqual(result["verdict"], "supported")
        self.assertTrue(result["quote_verified"])
        self.assertEqual(result["human_verdict"], "accept")

    def test_fabricated_quote_never_supported(self):
        result = v.finalize_row(self.row(quote="Treatment cured everyone."), self.sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")
        self.assertIsNone(result["quote"])

    def test_fabricated_sentence_never_supported(self):
        result = v.finalize_row(self.row(), "Unrelated manuscript text.", self.source())
        self.assertEqual(result["verdict"], "flagged")

    def test_silence_depends_on_coverage(self):
        for tier, expected in [("abstract_only", "needs_full_text"), ("partial_text", "needs_full_text"),
                               ("full_text", "not_supported")]:
            with self.subTest(tier=tier):
                second = {"relation": "silent", "quote": None, "uncertain": False}
                result = v.finalize_row(self.row(relation="silent", quote=None, second_pass=second), self.sentence, self.source(tier))
                self.assertEqual(result["verdict"], expected)

    def test_magnitude_mismatch_flagged(self):
        sentence = self.sentence.replace("25%", "50%")
        result = v.finalize_row(self.row(sentence=sentence), sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")
        self.assertEqual(result["missing_numbers"], ["50%"])

    def test_contradiction_requires_evidence(self):
        result = v.finalize_row(self.row(relation="contradicts", quote="made up"), self.sentence, self.source())
        self.assertEqual(result["verdict"], "flagged")

    def test_missing_source_unresolved(self):
        self.assertEqual(v.finalize_row(self.row(), self.sentence, None)["verdict"], "unresolved")

    def test_second_pass_required(self):
        result = v.finalize_row(self.row(second_pass=None), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_second_pass")

    def test_second_pass_disagreement(self):
        second = {"relation": "silent", "quote": None, "uncertain": False}
        result = v.finalize_row(self.row(second_pass=second), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_review")

    def test_second_pass_fabricated_evidence(self):
        second = {"relation": "supports", "quote": "Fabricated quote", "uncertain": False}
        result = v.finalize_row(self.row(second_pass=second), self.sentence, self.source())
        self.assertEqual(result["verdict"], "needs_review")

    def test_second_pass_uncertainty(self):
        second = {"relation": "supports", "quote": self.source()["text"], "uncertain": True}
        result = v.finalize_row(self.row(second_pass=second), self.sentence, self.source())
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


if __name__ == "__main__":
    unittest.main()
