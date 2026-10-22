#!/usr/bin/env python3
"""Citation evidence checks and recorded reviews through the existing Codex login."""
import argparse
import csv
import hashlib
import io
import json
import re
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from model_review import run_review, verified_execution, prepare_native, import_native, preflight
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from numeric_evidence import missing_numbers, numeric_checks

MAX_BYTES = 40_000_000
RELATIONS = {"supports", "contradicts", "off_topic", "silent"}


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def xml_text(element):
    return "" if element is None else " ".join("".join(element.itertext()).split())


def extract(path):
    path = Path(path)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Document exceeds the 40 MB extraction limit.")
    if path.suffix.lower() == ".docx":
        with zipfile.ZipFile(path) as archive:
            entry = archive.getinfo("word/document.xml")
            if entry.file_size > MAX_BYTES:
                raise ValueError("Expanded DOCX exceeds the extraction limit.")
            root = ET.fromstring(archive.read(entry))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for paragraph in root.findall(".//w:p", ns):
            parts = []
            for run in paragraph.findall(".//w:r", ns):
                text = "".join(t.text or "" for t in run.findall("w:t", ns))
                align = run.find("w:rPr/w:vertAlign", ns)
                if align is not None and align.get("{%s}val" % ns["w"]) == "superscript":
                    text = "^{" + text + "}"
                parts.append(text)
            paragraphs.append("".join(parts))
        text = "\n".join(paragraphs)
    elif path.suffix.lower() == ".pdf":
        result = subprocess.run(["pdftotext", "-layout", str(path.resolve()), "-"],
                                check=True, capture_output=True, timeout=90)
        text = result.stdout.decode("utf-8")
    elif path.suffix.lower() in {".txt", ".md"}:
        text = path.read_text(encoding="utf-8")
    else:
        raise ValueError("Use .txt, .md, .docx, or a selectable-text .pdf.")
    if not text.strip():
        raise ValueError("No selectable text found; OCR is not included.")
    return text


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "PaperTrellisCitationVerifier/0.1"})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError("Source exceeds the retrieval limit; no partial result accepted.")
    return body


def identifier_query(identifier):
    identifier = identifier.strip()
    identifier = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", identifier, flags=re.I)
    identifier = re.sub(r"^doi:\s*", "", identifier, flags=re.I)
    if re.fullmatch(r"10\.\d{4,9}/[^\s\"\\]+", identifier):
        return 'DOI:"' + identifier + '"'
    pmid = re.fullmatch(r"(?:PMID:\s*)?(\d+)", identifier, re.I)
    if pmid:
        return "EXT_ID:" + pmid[1] + " AND SRC:MED"
    raise ValueError("Provide a DOI or PMID. Resolve title-only references first.")


def fetch_source(identifier, get_impl=get):
    query = identifier_query(identifier)
    url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + urllib.parse.urlencode(
        {"query": query, "format": "json", "resultType": "core", "pageSize": 2})
    response = json.loads(get_impl(url))
    results = response.get("resultList", {}).get("result", [])
    if len(results) != 1:
        raise ValueError("No unique Europe PMC match. Resolve this reference using other sources.")
    paper = results[0]
    source = {"identifier": identifier, "title": paper.get("title"),
              "doi": paper.get("doi"), "pmid": paper.get("pmid"),
              "authors": paper.get("authorString"), "year": paper.get("pubYear"),
              "retrieved_at": datetime.now(timezone.utc).isoformat(),
              "tier": "abstract_only", "url": url, "text": ""}
    pmcid = paper.get("pmcid", "")
    if re.fullmatch(r"PMC\d+", pmcid):
        full_url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
        try:
            article = ET.fromstring(get_impl(full_url))
            body = article.find("body")
            if body is not None and xml_text(body):
                source.update(tier="full_text", url=full_url,
                              text=xml_text(article.find("front")) + "\n" + xml_text(body))
        except (OSError, ValueError, ET.ParseError) as error:
            source["full_text_note"] = f"Full-text retrieval failed ({type(error).__name__}); abstract fallback."
    if not source["text"]:
        abstract = paper.get("abstractText", "")
        try:
            source["text"] = xml_text(ET.fromstring("<abstract>" + abstract + "</abstract>"))
        except ET.ParseError:
            source["text"] = abstract
    if not source["text"].strip():
        raise ValueError("Matched paper has no retrievable text. Supply the paper or another source.")
    return source


def normalized(text):
    return " ".join(unicodedata.normalize("NFKC", str(text)).split())


def finalize_row(row, manuscript, source, *, check_second=True, directory="."):
    if row.get("relation") not in RELATIONS:
        raise ValueError("Invalid relation in draft row.")
    result = dict(row)
    for stale in ("second_pass_validation", "execution", "second_execution", "second_pass_blind",
                  "quote_span", "source_excerpt", "validation_note"):
        result.pop(stale, None)
    result.update(verdict="unresolved", quote_verified=False)
    sentence = row.get("sentence")
    if not isinstance(sentence, str) or not sentence.strip() or normalized(sentence) not in normalized(manuscript):
        result.update(verdict="flagged", validation_note="Citing sentence is absent from the manuscript.")
        return result
    if source is None:
        result["validation_note"] = "No matched source text was available."
        return result
    if source.get("tier") not in {"full_text", "abstract_only", "partial_text"} or not source.get("text", "").strip():
        raise ValueError("Source requires nonempty text and a valid coverage tier.")
    corpus = source["text"]
    result.update(source_tier=source["tier"], source_url=source.get("url"),
                  source_title=source.get("title"), source_identifier=source.get("identifier"),
                  source_sha256=hashlib.sha256(corpus.encode()).hexdigest(),
                  source_retrieved_at=source.get("retrieved_at"),
                  full_text_note=source.get("full_text_note"))
    quote = row.get("quote")
    valid_quote = isinstance(quote, str) and bool(quote.strip()) and normalized(quote) in normalized(corpus)
    result["quote_verified"] = bool(valid_quote)
    if valid_quote:
        # Offsets refer to the explicitly normalized source, not PDF coordinates.
        corpus_normalized, quote_normalized = normalized(corpus), normalized(quote)
        start = corpus_normalized.index(quote_normalized)
        result["quote_span"] = [start, start + len(quote_normalized)]
        result["source_excerpt"] = corpus_normalized[max(0, start - 300):start + len(quote_normalized) + 300]
    result["missing_numbers"] = missing_numbers(sentence, corpus)
    result["numeric_checks"] = numeric_checks(sentence, corpus)
    relation = row["relation"]
    if relation == "silent":
        result["verdict"] = "needs_full_text" if source["tier"] != "full_text" else "needs_review"
    elif not valid_quote:
        result.update(verdict="flagged", validation_note="Evidence quote is missing or absent from source text.")
        result["proposed_quote"] = quote
        result["quote"] = None
    elif relation == "supports":
        result["verdict"] = "flagged" if result["missing_numbers"] else "supported"
        if result["missing_numbers"]:
            result["validation_note"] = "Claim numbers lack a compatible source value under conservative formatting, bound, and explicit count-rounding checks; inspect manually."
    else:
        result["verdict"] = "not_supported"
    if check_second:
        # Preserve both executions and quote locations even when the first pass
        # is silent, uncertain, or flagged. Audit evidence is not just for positives.
        first_execution = verified_execution(row, source, directory, row, "first")
        result["execution"] = first_execution
        second = row.get("second_pass")
        if not isinstance(second, dict):
            if result["verdict"] in {"supported", "not_supported"}:
                result.update(verdict="needs_second_pass", validation_note="A second model judgment is required.")
        else:
            proposal = {"sentence": sentence, "relation": second.get("relation"),
                        "quote": second.get("quote"), "reason": second.get("reason")}
            if second.get("relation") not in RELATIONS:
                result.update(verdict="needs_review", validation_note="The second pass has an invalid relation.")
                return result
            checked = finalize_row(proposal, manuscript, source, check_second=False)
            result["second_pass_validation"] = checked
            if (valid_quote or relation == "silent") and (checked["verdict"] != result["verdict"] or second.get("relation") != relation):
                result.update(verdict="needs_review", validation_note="The two passes disagree or second-pass evidence failed validation.")
            elif valid_quote and (second.get("uncertain") is not False or row.get("uncertain") is not False):
                result.update(verdict="needs_review", validation_note="The second pass is uncertain or did not record its uncertainty.")
            second_execution = verified_execution(row, source, directory, second, "second")
            result["execution"] = first_execution
            result["second_execution"] = second_execution
            distinct = (first_execution and second_execution
                        and first_execution["thread_id"] != second_execution["thread_id"]
                        and first_execution["run_id"] != second_execution["run_id"])
            result["second_pass_blind"] = bool(distinct)
            if result["verdict"] in {"supported", "not_supported"} and not distinct:
                result.update(verdict="needs_second_pass",
                              validation_note="Two distinct source-only model executions are required; same-context notes do not count.")
    return result


def review_presentation(row):
    """Add actionable labels without altering verdicts, judgments or human fields."""
    categories = []
    second = row.get("second_pass") or {}
    checked = row.get("second_pass_validation") or {}
    if not row.get("source_file") or row.get("verdict") == "needs_full_text":
        categories.append("evidence_unavailable")
    if ((row.get("source_file") and (row.get("uncertain") is not False or (second and second.get("uncertain") is not False)))
            or row.get("relation") in {"silent", "off_topic"}):
        categories.append("attribution_qualification_uncertainty")
    if second and row.get("relation") != second.get("relation"):
        categories.append("reviewer_disagreement")
    if row.get("relation") == "contradicts" or second.get("relation") == "contradicts":
        categories.append("likely_claim_source_contradiction")
    if (row.get("missing_numbers") or checked.get("missing_numbers")
            or row.get("verdict") == "flagged" or checked.get("verdict") == "flagged"):
        categories.append("numeric_quote_software_validation_flag")
    if row.get("verdict") == "needs_second_pass":
        categories.append("review_execution_pending")
    actions = {
        "evidence_unavailable": "Resolve the reference or obtain the missing full text; silence is not contradiction.",
        "attribution_qualification_uncertainty": "Inspect endpoint, population, qualification and clause attribution in context.",
        "reviewer_disagreement": "Compare both original reasons and source quotes; adjudicate without discarding either judgment.",
        "likely_claim_source_contradiction": "Inspect the claimed conflict against both quotes and study context; this is a candidate for human review.",
        "numeric_quote_software_validation_flag": "Inspect exact numeric checks, units/signs and proposed quotes against the preserved source.",
        "review_execution_pending": "Complete the missing distinct source-only execution; keep the current verdict pending."}
    return {"review_categories": categories, "review_actions": [actions[c] for c in categories],
            "clause_mapping_status": "not_recorded",
            "clause_guidance": "This pair retains the entire citing sentence. Exact clause mapping is not recorded; inspect attribution ambiguity without assigning clauses or rewriting the claim."}


def finalize(draft, manuscript, out):
    draft = Path(draft)
    rows = json.loads(draft.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Draft must contain a nonempty array of citation rows.")
    ids = [row.get("id") for row in rows]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Every citation pair requires a unique nonempty string ID.")
    manuscript_text = Path(manuscript).read_text(encoding="utf-8")
    results = []
    for row in rows:
        source = None
        if row.get("source_file"):
            source = json.loads((draft.parent / row["source_file"]).read_text(encoding="utf-8"))
        result = finalize_row(row, manuscript_text, source, directory=draft.parent)
        result.update(review_presentation(result))
        results.append(result)
    output = Path(out)
    save_json(str(output) + ".json", {"version": 2, "checked_at": datetime.now(timezone.utc).isoformat(),
                                     "evidence_policy": "Preserve quotes, context, hashes, and execution records; do not redact proof from exports.",
                                     "rows": results})
    fields = ["id", "sentence", "manuscript_location", "reference", "verdict", "relation", "quote", "quote_verified",
              "reason", "source_tier", "source_url", "source_title", "source_identifier", "source_sha256",
              "model", "execution", "quote_span", "source_excerpt", "proposed_quote",
              "second_pass", "second_pass_validation", "second_execution", "second_pass_blind",
              "missing_numbers", "numeric_checks", "validation_note", "human_verdict", "human_notes",
              "review_categories", "review_actions", "clause_mapping_status", "clause_guidance"]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for row in results:
        # Prevent spreadsheet formula execution when users open the export.
        cells = {key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value
                 for key, value in row.items()}
        writer.writerow({key: ("'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value)
                         for key, value in cells.items()})
    Path(str(output) + ".csv").write_text(buffer.getvalue(), encoding="utf-8")
    return results


def check_export(path):
    """Check an exported report without trusting its quote_verified booleans."""
    path = Path(path)
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("version") != 2 or not isinstance(report.get("rows"), list):
        raise ValueError("Export must be an unmodified version 2 verifier report.")
    executions_checked = 0
    for row in report["rows"]:
        for key, value in review_presentation(row).items():
            if key in row and row[key] != value:
                raise ValueError("Export review presentation changed: " + key + " for " + row["id"])
        # Pending/disputed results need the same auditability as confirmed results.
        # A declared execution must validate even if the verdict is not confirmed.
        if row.get("verdict") in {"supported", "not_supported"} and not row.get("quote"):
            raise ValueError("Export is missing inspectable evidence for " + row["id"])
        if row.get("source_file"):
            source = json.loads((path.parent / row["source_file"]).read_text(encoding="utf-8"))
            for stage, judgment, receipt_key in (("first", row, "execution"),
                    ("second", row.get("second_pass", {}), "second_execution")):
                if not isinstance(judgment, dict) or not judgment.get("execution_file"):
                    continue
                # Invalid quotes remain inspectable as proposed_quote; the actual
                # executed response is never overwritten in its raw record.
                original = dict(judgment)
                if "proposed_quote" in original:
                    original["quote"] = original["proposed_quote"]
                receipt = verified_execution(row, source, path.parent, original, stage)
                if not receipt or row.get(receipt_key) != receipt:
                    raise ValueError("Export execution record changed or missing for " + row["id"])
                executions_checked += 1
            replay = dict(row)
            if "proposed_quote" in replay:
                replay["quote"] = replay["proposed_quote"]
            expected = finalize_row(replay, row["sentence"], source, directory=path.parent)
            for key in ("source_sha256", "source_url", "source_title", "source_identifier",
                        "source_tier", "quote_span", "source_excerpt", "second_pass_validation",
                        "second_pass_blind", "missing_numbers", "numeric_checks"):
                if row.get(key) != expected.get(key):
                    raise ValueError("Export evidence field changed: " + key + " for " + row["id"])
        if row.get("verdict") not in {"supported", "not_supported"}:
            continue
        for checked in (row, row.get("second_pass_validation", {})):
            if (not isinstance(checked.get("quote"), str) or not checked["quote"].strip()
                    or normalized(checked["quote"]) not in checked.get("source_excerpt", "")):
                raise ValueError("Export is missing inspectable evidence for " + row["id"])
        second_judgment = row.get("second_pass", {})
        if second_judgment.get("quote") != row["second_pass_validation"].get("quote"):
            raise ValueError("Export lost the second-pass quote for " + row["id"])
        if (row.get("relation") != second_judgment.get("relation") or row.get("uncertain") is not False
                or second_judgment.get("uncertain") is not False):
            raise ValueError("Export claims agreement despite uncertainty/disagreement for " + row["id"])
        source = json.loads((path.parent / row["source_file"]).read_text(encoding="utf-8"))
        first = verified_execution(row, source, path.parent, row, "first")
        second = verified_execution(row, source, path.parent, row.get("second_pass", {}), "second")
        if not first or not second or first["thread_id"] == second["thread_id"]:
            raise ValueError("Export has no distinct execution records for " + row["id"])
        if hashlib.sha256(source["text"].encode()).hexdigest() != row.get("source_sha256"):
            raise ValueError("Export source hash changed for " + row["id"])
        if any(normalized(item["quote"]) not in normalized(source["text"])
               for item in (row, row["second_pass"])):
            raise ValueError("Export quote is absent from the source for " + row["id"])
        if row["verdict"] == "supported" and (row["relation"] != "supports" or missing_numbers(row["sentence"], source["text"])):
            raise ValueError("Export supported verdict failed its evidence gates for " + row["id"])
    return {"status": "passed", "rows": len(report["rows"]), "executions_checked": executions_checked,
            "scope": "Export integrity and recorded executions; not proof of semantic accuracy."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("extract", "fetch", "finalize", "model-review"):
        sub = commands.add_parser(name)
        sub.add_argument("input")
        sub.add_argument("--out", required=True)
        if name == "finalize":
            sub.add_argument("--manuscript", required=True)
        if name == "model-review":
            sub.add_argument("--stage", choices=["first", "second"], required=True)
            sub.add_argument("--model", required=True)
            sub.add_argument("--effort", choices=["medium", "high"], default="high")
            sub.add_argument("--timeout", type=int, default=240)
    sub = commands.add_parser("preflight")
    sub.add_argument("input")
    sub.add_argument("--out", required=True)
    sub.add_argument("--batch-size", type=int, default=8)
    sub.add_argument("--max-chars", type=int, default=300_000)
    sub.add_argument("--capabilities")
    sub.add_argument("--model")
    sub = commands.add_parser("prepare-native")
    sub.add_argument("input")
    sub.add_argument("--stage", choices=["first", "second"], required=True)
    sub.add_argument("--out", required=True)
    sub.add_argument("--allow-inherited-model", action="store_true", help="Explicitly accept unknown inherited model/cost when selection is unavailable.")
    sub.add_argument("--pair-id", action="append", help="Explicit resumable batch IDs; repeat per pair.")
    sub.add_argument("--capabilities")
    sub.add_argument("--model")
    sub = commands.add_parser("import-native")
    sub.add_argument("input")
    sub.add_argument("--request", required=True)
    sub.add_argument("--record", required=True)
    sub.add_argument("--out", required=True)
    sub = commands.add_parser("check-export")
    sub.add_argument("input")
    args = parser.parse_args()
    try:
        if args.command == "extract":
            text = extract(args.input)
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(text, encoding="utf-8")
            print(f"Extracted {len(text)} characters to {args.out}")
        elif args.command == "fetch":
            save_json(args.out, fetch_source(args.input))
            print(f"Saved source to {args.out}")
        elif args.command == "preflight":
            summary = preflight(args.input, args.batch_size, args.max_chars, args.capabilities, args.model)
            save_json(args.out, summary)
            print(json.dumps(summary))
        elif args.command == "prepare-native":
            print(json.dumps(prepare_native(args.input, args.stage, args.out, args.pair_id, args.capabilities, args.model, args.allow_inherited_model)))
        elif args.command == "import-native":
            print(json.dumps(import_native(args.input, args.request, args.record, args.out)))
        elif args.command == "model-review":
            receipt = run_review(args.input, args.out, args.stage, args.model, args.effort, args.timeout)
            print(json.dumps({"status": receipt["status"], "stage": receipt["stage"],
                              "model_requested": receipt["model_requested"], "thread_id": receipt["thread_id"]}))
        elif args.command == "check-export":
            print(json.dumps(check_export(args.input)))
        else:
            rows = finalize(args.input, args.manuscript, args.out)
            print(json.dumps({"rows": len(rows), "verdicts": {v: sum(r["verdict"] == v for r in rows)
                              for v in sorted({r["verdict"] for r in rows})}}))
    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(f"Citation verifier: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
