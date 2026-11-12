#!/usr/bin/env python3
"""Adds the IG review script to every HTML page of an IG Publisher output folder.

    python3 inject.py output --repo HL7Austria/AIST-TrustworthyAI-R5 --branch main --commit <sha>

Run in CI after the IG Publisher and before deploying. Pages that already carry the tag are
left alone, so running it twice is harmless. Branches starting with "ballot" get the ballot form.
"""
import argparse
import html
import pathlib
import sys

SRC = "https://fhir.hl7.at/ig-review/review.js"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("outdir")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--branch", required=True)
    ap.add_argument("--commit", default="")
    ap.add_argument("--mode", choices=["review", "ballot"], help="default: ballot for branches starting with 'ballot'")
    ap.add_argument("--src", default=SRC)
    a = ap.parse_args()
    mode = a.mode or ("ballot" if a.branch.lower().startswith("ballot") else "review")
    tag = (f'<script src="{html.escape(a.src)}" data-repo="{html.escape(a.repo)}" data-branch="{html.escape(a.branch)}" '
           f'data-commit="{html.escape(a.commit)}" data-mode="{mode}" defer></script>')
    done = skipped = 0
    for p in pathlib.Path(a.outdir).rglob("*.html"):
        s = p.read_text(encoding="utf-8", errors="surrogateescape")
        i = s.rfind("</body>")
        if i < 0 or a.src in s:
            skipped += 1
            continue
        p.write_text(s[:i] + tag + "\n" + s[i:], encoding="utf-8", errors="surrogateescape")
        done += 1
    print(f"[ig-review] {mode} mode for {a.repo}@{a.branch}: script added to {done} pages ({skipped} skipped)")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
