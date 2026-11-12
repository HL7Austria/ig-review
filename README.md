# HL7 Austria IG review

Mark text directly on a published FHIR IG page, comment on it, and see and answer all comments
right where they were made. Every comment is a **GitHub issue in the IG's own repository**.
Intended as the basis for HL7 Austria ballots.

Served from GitHub Pages: `https://fhir.hl7.at/ig-review/review.js`.

## How it works

1. **CI injects one script tag** into every page of the IG Publisher output (`tools/inject.py`):
   ```html
   <script src="https://fhir.hl7.at/ig-review/review.js" data-repo="HL7Austria/X" data-branch="main" data-commit="…" data-mode="review" defer></script>
   ```
2. **Readers** select text → **💬 Comment** → fill in the form → *Sign in with GitHub* → an issue is created
   in the IG repo under their own GitHub account. The panel (button bottom right) lists all comments
   of the page; marked passages are highlighted and numbered with the issue number. Click one to read
   it, its discussion, and reply.
3. **CI labels the issue and writes a comment index** (`tools/build_index.py`) to `review-index.json`
   next to the published pages, so pages load the comments without hitting GitHub API limits.
   Signed-in users additionally get changes since the index was built live from the API.

### Two modes, chosen by branch name

| Branch | Form | Labels set by CI |
|---|---|---|
| any (e.g. `main`) | type (question / suggestion / typo / major issue), comment, optional proposed wording | `review`, `branch:<b>`, `type:<t>` |
| `ballot*` | HL7 ballot type (A-S, A-T, A-Q, A-C, NEG), comment, proposed wording (required for NEG), "discuss in person" | `review`, `branch:<b>`, `ballot:<b>`, `ballot-type:<t>`, `in-person` |

Work groups record the outcome with `disposition:*` labels (e.g. `disposition:persuasive`); the panel shows it.

### Anchors

The issue body ends with a hidden block:
```
<!-- ig-review: anchor of this comment on the published IG page (do not edit)
{"page": "StructureDefinition-x.html", "branch": "main", "commit": "…", "mode": "review", "type": "suggestion",
 "quote": {"exact": "…", "prefix": "…", "suffix": "…"}, "position": {"start": 1234, "end": 1260},
 "context": {"element": "Device.extension:dataTransfer", "heading": "…"}}
-->
```
After a rebuild the page searches the quote (whitespace-insensitive) and uses the surrounding text and the
old position to pick the right occurrence. Comments whose text is gone are listed under *Can no longer be
located on this page*.

## Adding it to an IG repository

1. In the IG's publish workflow, after the IG Publisher and before deploying:
   ```yaml
   - uses: actions/checkout@v4
     with: { repository: HL7Austria/ig-review, path: ig-review-tool }
   - name: Add review tool and comment index
     continue-on-error: true
     env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
     run: |
       python3 ig-review-tool/tools/inject.py output --repo ${{ github.repository }} --branch "$BRANCH" --commit ${{ github.sha }}
       python3 ig-review-tool/tools/build_index.py --repo ${{ github.repository }} --branch "$BRANCH" --out output/review-index.json
   ```
2. Add a workflow that relabels the issue and republishes `review-index.json` on issue/comment events
   (see `AIST-TrustworthyAI-R5/.github/workflows/review-index.yml`).
3. Install the GitHub App **hl7-austria-ig-review** on the IG repository (issues: read & write).

## Sign-in

GitHub App `hl7-austria-ig-review` (client id `Iv23li4OcsdZoj3gsUeY`). Its callback is
`https://fhir.hl7.at/ig-review/callback.html`. The one-time code is swapped for a user token by the Cloudflare
Worker `hl7at-ig-comparison-auth` (source in
[AT-INTL-AI-Transparency-IG-Comparison/worker](https://github.com/HL7Austria/AT-INTL-AI-Transparency-IG-Comparison/tree/main/worker)),
because that step needs the app's client secret. The token lives in `sessionStorage` of the tab only.
