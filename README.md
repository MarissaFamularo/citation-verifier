# Citation Verifier

Does the paper a manuscript cites actually support the sentence that cites it?

Upload a manuscript. The tool pulls out the reference list, pairs every citing
sentence with the reference it cites, fetches each cited paper, and checks the
pair two ways. You then record your own verdict — accept, reject, or other,
with notes — on every citation, and export the table.

Built for peer reviewers and authors. References are matched in PubMed first,
then in OpenAlex — so arXiv and other preprints, conference papers, and
non-biomedical journals are covered too.

## How a citation is checked

1. **Code** reads the .docx or PDF, splits off the reference list(s), and matches citation
   markers (`[12]`, superscripts, `(12)`, ranges, author–year) to sentences.
2. **Code** matches each reference by DOI, PMID, arXiv id, or title (PubMed, then
   Crossref and OpenAlex), then fetches full text when it is open — PMC for
   biomedical papers, the arXiv PDF for preprints — otherwise the abstract. Every
   result says which one was checked — "not in the abstract" is a much weaker
   finding than "not in the paper".
3. **Claude** proposes a verdict and the verbatim passage that backs it. The app
   then proves that passage exists in the fetched text; a quote it cannot find is
   discarded and the citation is flagged, never shown as supported. Numbers in
   the citing sentence are checked against the paper in code.
4. **Jev** ([TypeSafe](https://typesafe.ai)'s System One model) reads the sentence
   next to that passage and returns a probability for *supports / contradicts /
   says nothing*. P(supports) is the reliability mark; low confidence means Jev
   itself is unsure.
5. **You** decide. Model output never overwrites a human verdict.

Either model works on its own; with both, Jev scores the quote Claude proved.

## Privacy

There is no database and no application server. The manuscript is read in your
browser. TypeSafe's API does not accept browser requests, so those calls are
relayed by a stateless rewrite on the host (`netlify.toml`; the Vite proxy in
development) that stores and logs nothing.
Citing sentences and cited-paper text go to Anthropic and TypeSafe under **your
own API keys**, which are kept in browser storage only (cleared when the tab
closes unless you tick "remember"). A review is saved as a JSON file you
download and can re-open later.

Manuscripts under peer review are confidential. Check the journal's policy and
each provider's data terms before using this on one.

## Run it

```bash
npm install
cp .env.example .env.local   # set VITE_CONTACT_EMAIL (used for Unpaywall lookups)
npm run dev
```

`npm test` runs the unit tests; `samples/sample-manuscript.txt` is a tiny
manuscript with one deliberately wrong citation to try it on.

You need an [Anthropic API key](https://console.anthropic.com) and/or a
[TypeSafe API key](https://console.typesafe.ai). An NCBI key is optional and
speeds up PubMed lookups.

## Limits

- PDFs are read from the position of the text on the page (columns, real superscripts, running headers), which works on typeset journal PDFs and ordinary manuscript PDFs with selectable text. Scanned PDFs are not read. Text copy-pasted out of a PDF viewer is not reliable — upload the file.
- References that are not papers (guidelines, regulations, websites, software) are listed but cannot be checked automatically. Neither can a paper with no abstract on record whose publisher blocks browser downloads — the row says so rather than guessing.
- Paywalled papers are checked against the abstract only.
- Model verdicts are a triage aid, not a finding. Thresholds have not yet been
  validated on a labeled set of biomedical citations.

## License

MIT
