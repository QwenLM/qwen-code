#!/usr/bin/env python3
"""Mutation matrix for PR 9228's ci-runner-routing.test.mjs pin.

For each mutation we copy the PR-head .github tree into a temp dir, apply one
edit to serve-ab.yml, run the PR-head test file against it, and record whether
the test caught the mutation. A mutation that still passes is a hole in the pin.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HEAD = "/Users/wenshao/pr9228-verify/head"
BASE = "/Users/wenshao/pr9228-verify/base"
EVID = "/Users/wenshao/pr9228-verify/evidence"

HEAD_WIPE = "find \"$GITHUB_WORKSPACE\" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +"
BASE_WIPE = 'find "$GITHUB_WORKSPACE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
WIPE_NAME = "Wipe stale workspace except the shared .git before checkout"


def steps_of(text):
    """Split the `ab` job's steps block into (prefix, [step_texts], suffix)."""
    marker = "    steps:\n"
    i = text.index(marker) + len(marker)
    prefix, body = text[:i], text[i:]
    parts = re.split(r"(?m)^(?=      - )", body)
    parts = [p for p in parts if p.strip()]
    return prefix, parts


def rebuild(prefix, parts):
    return prefix + "".join(parts)


def find_step(parts, needle):
    for idx, p in enumerate(parts):
        if needle in p:
            return idx
    raise SystemExit(f"step not found: {needle}")


# --- mutations -------------------------------------------------------------
def m_none(t):
    return t


def m_base_wipe_line(t):
    return t.replace(HEAD_WIPE, BASE_WIPE)


def m_base_whole_step(t):
    """Full revert of the workflow half of the PR (base serve-ab.yml)."""
    return subprocess.run(
        ["git", "-C", BASE, "show", "HEAD:.github/workflows/serve-ab.yml"],
        capture_output=True, text=True, check=True).stdout


def m_continue_on_error(t):
    return t.replace(
        f"      - name: '{WIPE_NAME}'\n",
        f"      - name: '{WIPE_NAME}'\n        continue-on-error: true\n", 1)


def m_shell_sh(t):
    return t.replace(
        f"      - name: '{WIPE_NAME}'\n",
        f"      - name: '{WIPE_NAME}'\n        shell: 'sh'\n", 1)


def m_job_bash_env(t):
    return t.replace("  ab:\n", "  ab:\n    env:\n      BASH_ENV: '/tmp/x.sh'\n", 1)


def m_wipe_before_ownership(t):
    prefix, parts = steps_of(t)
    w = find_step(parts, WIPE_NAME)
    step = parts.pop(w)
    o = find_step(parts, "Restore workspace ownership")
    parts.insert(o, step)
    return rebuild(prefix, parts)


def m_checkout_before_wipe(t):
    prefix, parts = steps_of(t)
    c = find_step(parts, "Checkout PR head")
    step = parts.pop(c)
    w = find_step(parts, WIPE_NAME)
    parts.insert(w, step)
    return rebuild(prefix, parts)


def m_gitignore_typo(t):
    return t.replace("! -name '.git'", "! -name '.gitignore'")


def m_drop_wipe_step(t):
    prefix, parts = steps_of(t)
    parts.pop(find_step(parts, WIPE_NAME))
    return rebuild(prefix, parts)


def m_keep_dot_git_but_rename_step(t):
    return t.replace(WIPE_NAME, "Wipe stale workspace before checkout")


MUTATIONS = [
    ("00 baseline (unmutated PR head)", m_none, "pass"),
    ("01 revert wipe line to base (whole-workspace wipe)", m_base_wipe_line, "fail"),
    ("02 revert the entire workflow file to base", m_base_whole_step, "fail"),
    ("03 add continue-on-error: true to the wipe", m_continue_on_error, "fail"),
    ("04 force shell: sh on the wipe", m_shell_sh, "fail"),
    ("05 inject job-level BASH_ENV", m_job_bash_env, "fail"),
    ("06 move the wipe before ownership-restore", m_wipe_before_ownership, "fail"),
    ("07 move 'Checkout PR head' before the wipe", m_checkout_before_wipe, "fail"),
    ("08 typo the exclusion: .git -> .gitignore", m_gitignore_typo, "fail"),
    ("09 delete the wipe step entirely", m_drop_wipe_step, "fail"),
    ("10 rename the wipe step back to the old name", m_keep_dot_git_but_rename_step, "fail"),
]


def run_once(label, fn):
    tmp = tempfile.mkdtemp(prefix="pr9228-mut-")
    try:
        shutil.copytree(os.path.join(HEAD, ".github"), os.path.join(tmp, ".github"))
        os.symlink(os.path.join(HEAD, "node_modules"), os.path.join(tmp, "node_modules"))
        wf = os.path.join(tmp, ".github/workflows/serve-ab.yml")
        with open(wf) as f:
            text = f.read()
        mutated = fn(text)
        if label != "00 baseline (unmutated PR head)" and mutated == text:
            return "NO-OP", "mutation did not change the file"
        with open(wf, "w") as f:
            f.write(mutated)
        p = subprocess.run(
            ["node", "--test", ".github/scripts/ci-runner-routing.test.mjs"],
            cwd=tmp, capture_output=True, text=True)
        ok = p.returncode == 0
        detail = ""
        if not ok:
            for line in (p.stdout + p.stderr).splitlines():
                s = line.strip()
                if s.startswith("[ERROR]") or "AssertionError" in s or s.startswith("message:") or s.startswith("+ actual") or s.startswith("- expected"):
                    detail = s
                    break
                if "not ok" in s and "serve-ab" not in s and "✖" not in s:
                    detail = s
        return ("pass" if ok else "fail"), detail
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    rows = []
    for label, fn, expect in MUTATIONS:
        got, detail = run_once(label, fn)
        verdict = "OK" if got == expect else "HOLE"
        rows.append((label, expect, got, verdict, detail))
        print(f"{verdict:5} {label:52} expect={expect:4} got={got}")
    holes = [r for r in rows if r[3] != "OK"]
    print()
    print(f"{len(rows) - len(holes)}/{len(rows)} mutations behaved as expected; holes: {len(holes)}")
    with open(os.path.join(EVID, "t1-mutation-matrix.txt"), "w") as f:
        for label, expect, got, verdict, detail in rows:
            f.write(f"{verdict:5} {label:52} expect={expect:4} got={got}\n")
        f.write(f"\n{len(rows) - len(holes)}/{len(rows)} as expected; holes: {len(holes)}\n")
    return 1 if holes else 0


if __name__ == "__main__":
    sys.exit(main())
