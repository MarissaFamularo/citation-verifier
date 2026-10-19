#!/usr/bin/env python3
"""Local citation evidence checks. Standard library only; no model API calls."""
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
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

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


def missing_numbers(sentence, corpus):
    # Conservative token presence only. No claim of units or statistical equivalence.
    sentence = re.sub(r"\[[\d\s,;–—-]+\]|\^\{[^}]+\}", "", sentence)
    pattern = r"(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?%?"
    source_tokens = {t.replace(",", "") for t in re.findall(pattern, normalized(corpus))}
    missing = []
    for token in re.findall(pattern, normalized(sentence)):
        number = float(token.replace(",", "").rstrip("%"))
        if token.isdigit() and (number <= 12 or 1900 <= number <= 2100):
            continue
        if token.replace(",", "") not in source_tokens and token not in missing:
            missing.append(token)
    return missing


def finalize_row(row, manuscript, source, *, check_second=True):
    if row.get("relation") not in RELATIONS:
        raise ValueError("Invalid relation in draft row.")
    result = dict(row)
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
    result["missing_numbers"] = missing_numbers(sentence, corpus)
    relation = row["relation"]
    if relation == "silent":
        result["verdict"] = "needs_full_text" if source["tier"] != "full_text" else "not_supported"
    elif not valid_quote:
        result.update(verdict="flagged", validation_note="Evidence quote is missing or absent from source text.")
        result["quote"] = None
    elif relation == "supports":
        result["verdict"] = "flagged" if result["missing_numbers"] else "supported"
        if result["missing_numbers"]:
            result["validation_note"] = "Claim numbers absent from source; inspect manually."
    else:
        result["verdict"] = "not_supported"
    if check_second and result["verdict"] in {"supported", "not_supported"}:
        second = row.get("second_pass")
        if not isinstance(second, dict):
            result.update(verdict="needs_second_pass", validation_note="A second model judgment is required.")
        else:
            proposal = {"sentence": sentence, "relation": second.get("relation"),
                        "quote": second.get("quote"), "reason": second.get("reason")}
            checked = finalize_row(proposal, manuscript, source, check_second=False)
            result["second_pass_validation"] = checked
            if checked["verdict"] != result["verdict"] or second.get("relation") != relation:
                result.update(verdict="needs_review", validation_note="The two passes disagree or second-pass evidence failed validation.")
            elif second.get("uncertain") is not False:
                result.update(verdict="needs_review", validation_note="The second pass is uncertain or did not record its uncertainty.")
            result["second_pass_blind"] = second.get("blind") is True
    return result


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
        results.append(finalize_row(row, manuscript_text, source))
    output = Path(out)
    save_json(str(output) + ".json", {"version": 1, "checked_at": datetime.now(timezone.utc).isoformat(),
                                     "rows": results})
    fields = ["id", "sentence", "reference", "verdict", "relation", "quote", "quote_verified",
              "reason", "source_tier", "source_url", "source_title", "source_identifier", "source_sha256",
              "model", "second_pass", "second_pass_validation", "second_pass_blind",
              "missing_numbers", "validation_note", "human_verdict", "human_notes"]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for row in results:
        # Prevent spreadsheet formula execution when users open the export.
        writer.writerow({key: ("'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value)
                         for key, value in row.items()})
    Path(str(output) + ".csv").write_text(buffer.getvalue(), encoding="utf-8")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("extract", "fetch", "finalize"):
        sub = commands.add_parser(name)
        sub.add_argument("input")
        sub.add_argument("--out", required=True)
        if name == "finalize":
            sub.add_argument("--manuscript", required=True)
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
