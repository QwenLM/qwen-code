# One Autofix Skill for Local and CI Runs

## Context

Qwen Code already has a repository-owned Autofix skill used by GitHub Actions.
It contains review-feedback triage and verification rules, while the workflow
owns scheduling, trust filtering, credentials, GitHub writes, and round
budgets.

Local Autofix should reuse that skill instead of adding a bundled skill or a
second maintenance engine. Its input is the current working tree, not a remote
pull request: staged, unstaged, and untracked changes are reviewed together.

## Design

The existing `.qwen/skills/autofix/SKILL.md` remains the only Autofix skill. It
has two entry paths:

- A direct `/autofix` invocation synchronously reviews and fixes the current
  working tree.
- The existing Actions runner supplies one of `assess-candidates`,
  `develop-issue`, or `address-review` plus trusted workflow-prepared files.

The local path repeatedly runs the existing machine-readable review command:

```bash
env -u SANDBOX QWEN_SANDBOX=true "${QWEN_CODE_CLI:-qwen}" review run --approval-mode auto --effort high --json --quiet
```

The command runs as a managed background shell so its own timeout, rather than
the shorter foreground-tool limit, remains authoritative. Autofix still waits
for it synchronously: the interactive TUI resumes from the terminal task
notification, while ACP, stream-json, and headless sessions inspect the status
sidecar at a bounded, increasing cadence. Working-tree fingerprints around the
review and immediately before convergence make any review side effect or
concurrent edit a visible `BLOCKED` outcome.

The nested headless review uses Auto approval mode inside the Qwen sandbox.
Autofix clears an inherited `SANDBOX` marker before startup so it cannot bypass
containment; an unavailable approval classifier or sandbox produces an
incomplete review and fails closed. Before launch, Autofix explains that review
may execute repository-defined checks in a sandboxed process that retains model
credentials and network access, then requires explicit confirmation that the
user trusts the repository. If untracked, non-ignored files exist, Autofix also
lists them before their contents enter review model context. Non-interactive
runs stop `BLOCKED` when confirmation is unavailable. On Windows, local Autofix
requires Git Bash/MSYS because the bundled review workflow uses POSIX shell
syntax; native cmd.exe and PowerShell fail closed before review starts.

After each complete review, Autofix reads the emitted report, verifies every
finding against the code, applies one minimal coherent fix batch, runs the
narrowest relevant checks, and reviews the resulting working tree again. It
does not poll GitHub or use `/loop`.

There is no fixed local round count. The process stops on evidence:

- `NO_CHANGES`: the working tree was clean before review.
- `CONVERGED`: a complete uncapped review has no actionable findings and all
  required checks pass.
- `BLOCKED`: review evidence is incomplete, a required check has no safe
  in-scope fix, or a maintainer/product decision is required.
- `STALLED`: the same actionable finding survives without a new hypothesis, no
  working-tree progress is made, or changes oscillate.

Local Autofix never stages, commits, pushes, rewrites history, changes the
index, or writes to GitHub. The user's existing staged state remains intact;
fixes are left as working-tree changes for inspection.

## Workflow boundary

GitHub Actions keeps all deterministic policy: triggers, authorization,
checkout, trusted-feedback selection, retry and round budgets, watermarks,
commits, pushes, comments, and final gates. Only model decision policy belongs
in the skill. In particular, the workflow may mark feedback as deferred while
the skill decides how an agent must treat that section.

## Rejected alternatives

- A bundled Autofix skill would collide with the repository skill and split the
  model contract.
- `on`, `off`, or `status` would control the remote workflow instead of fixing
  local changes.
- A new watcher, scheduler, or runtime state machine duplicates existing review
  and Actions infrastructure.
- A fixed local round cap can stop a progressing repair; progress-based stop
  conditions bound non-converging runs without imposing an arbitrary total.
