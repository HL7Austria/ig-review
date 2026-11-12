#!/usr/bin/env python3
"""Labels (CI) and an optional export of the review comments.

The pages read the comments live from the GitHub API; nothing here is published to the site.

    # export all review comments of one branch as JSON (e.g. for ballot reconciliation)
    python3 build_index.py --repo HL7Austria/AIST-TrustworthyAI-R5 --branch main --out output/review-index.json

    # after an issue event: label that issue from its hidden anchor block, print its branch
    python3 build_index.py --repo HL7Austria/AIST-TrustworthyAI-R5 --issue 12 --apply-labels

Review comments are issues whose body carries a hidden `<!-- ig-review ... -->` JSON block
(written by review.js). Commenters usually cannot set labels themselves, so CI labels them:
  review, branch:<branch>, type:<type> (normal branches) or ballot:<branch> + ballot-type:<A-S..NEG>
  (+ in-person) on ballot branches. Dispositions (disposition:*) are set by the work group.
Needs GITHUB_TOKEN (issues: write for --apply-labels).
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

META_RE = re.compile(r"<!--\s*ig-review\b[^\n]*\n(.*?)\n\s*-->", re.S)
LABEL_COLORS = {"review": "5319e7", "branch:": "c5def5", "type:": "fbca04", "ballot:": "8a1c1c", "ballot-type:": "d93f0b",
                "in-person": "0e8a16", "disposition:": "1d76db"}


def api(path, method="GET", data=None, accept="application/vnd.github.full+json"):
    url = path if path.startswith("http") else "https://api.github.com" + path
    out = []
    while url:
        req = urllib.request.Request(url, method=method, data=json.dumps(data).encode() if data is not None else None)
        req.add_header("Accept", accept)
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req) as r:
            payload = json.loads(r.read() or b"null")
            if method != "GET":
                return payload
            out.extend(payload if isinstance(payload, list) else [payload])
            m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link", ""))
            url = m.group(1) if m else None
    return out


def meta_of(issue):
    m = META_RE.search((issue.get("body") or "").replace("\r\n", "\n"))
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def labels_for(meta):
    b = meta.get("branch", "main")
    ls = ["review", f"branch:{b}"]
    if meta.get("mode") == "ballot":
        ls += [f"ballot:{b}", f"ballot-type:{meta.get('type', 'A-C')}"]
        if meta.get("inPerson"):
            ls.append("in-person")
    elif meta.get("type"):
        ls.append(f"type:{meta['type']}")
    return ls


def color(name):
    return next((c for p, c in LABEL_COLORS.items() if name.startswith(p)), "ededed")


def apply_labels(repo, number):
    issue = api(f"/repos/{repo}/issues/{number}")[0]
    meta = meta_of(issue)
    if not meta:
        return None
    have = {l["name"] for l in issue.get("labels", [])}
    want = [l for l in labels_for(meta) if l not in have]
    if want:
        existing = {l["name"] for l in api(f"/repos/{repo}/labels?per_page=100")}
        for l in want:
            if l not in existing:
                try:
                    api(f"/repos/{repo}/labels", "POST", {"name": l, "color": color(l)})
                except urllib.error.HTTPError as e:
                    if e.code != 422:  # already exists (race)
                        raise
        api(f"/repos/{repo}/issues/{number}/labels", "POST", {"labels": want})
    return meta.get("branch", "main")


def build_index(repo, branch):
    items = {}
    for i in api(f"/repos/{repo}/issues?state=all&per_page=100"):
        if "pull_request" in i:
            continue
        meta = meta_of(i)
        if not meta or meta.get("branch", "main") != branch:
            continue
        items[i["number"]] = {
            "number": i["number"], "url": i["html_url"], "title": i["title"], "state": i["state"],
            "author": i["user"]["login"], "avatar": i["user"]["avatar_url"], "created": i["created_at"],
            "body_html": i.get("body_html", ""), "meta": meta, "labels": [l["name"] for l in i.get("labels", [])],
            "commentCount": i.get("comments", 0), "comments": [],
        }
    if items:
        for c in api(f"/repos/{repo}/issues/comments?per_page=100&sort=created&direction=asc"):
            n = int(c["issue_url"].rsplit("/", 1)[1])
            if n in items:
                items[n]["comments"].append({"author": c["user"]["login"], "avatar": c["user"]["avatar_url"],
                                             "created": c["created_at"], "url": c["html_url"], "body_html": c.get("body_html", "")})
    return {"generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "repo": repo, "branch": branch, "items": [items[n] for n in sorted(items)]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--branch")
    ap.add_argument("--out")
    ap.add_argument("--issue", type=int)
    ap.add_argument("--apply-labels", action="store_true")
    a = ap.parse_args()
    if a.issue and a.apply_labels:
        b = apply_labels(a.repo, a.issue)
        print(f"branch={b or ''}")
        return 0
    idx = build_index(a.repo, a.branch)
    out = json.dumps(idx, ensure_ascii=False, indent=1)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        open(a.out, "w", encoding="utf-8").write(out + "\n")
    print(f"[ig-review] index for {a.repo}@{a.branch}: {len(idx['items'])} comments", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
