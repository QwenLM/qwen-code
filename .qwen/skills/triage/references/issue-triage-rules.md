# Issue Triage Rules

Reference material for `issue-workflow.md`. Detailed criteria and thresholds
that the workflow steps consult during execution. Gate model and markers are
defined in `SKILL.md`.

## Feature Request Product Direction

| Verdict   | Meaning                                                        | Route                                                             |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `aligned` | Solves a real Qwen Code workflow problem and can be scoped     | Label sanity, possible `welcome-pr` or implementation follow-up   |
| `discuss` | Plausible direction but product/architecture ownership unclear | `need-discussion` or `status/ready-for-human` if action is needed |
| `reject`  | Clearly incompatible, spam, or explicitly rejected             | Explain direction gently; do not close                            |

For `aligned` or `discuss`, answer:

- Product fit: does it solve a Qwen Code-specific workflow gap?
- KISS path: smallest useful version — docs, skill/prompt, command extension,
  or core architecture?
- Overlap: how does it differ from existing commands, skills, or roadmap?
- Welcome-PR readiness: self-contained enough for a contributor without
  maintainer-only decisions?

Route to maintainer discussion when the request affects auth, sandboxing,
model selection, daemon/remote execution, telemetry, release, or public
contracts.

## Priority P0-P3

- **P0**: catastrophic failure affecting most users, core product broken, data
  loss, severe security, release blocker.
- **P1**: serious issue affecting substantial subset or core feature, regression,
  no easy workaround. Feature requests are almost never P1.
- **P2**: moderate problem, does not block core usage, easy workaround or
  smaller subset affected.
- **P3**: cosmetic, typo, rare edge case, nice-to-have.

Adjustments: missing info → lower P0→P1 or P1→P2. Clear reproduction + many
affected → raise one level. Version ≥6 releases behind → `status/need-retesting`.

## Completeness Check

For bug reports, prefer full `/about` output. Parse case-insensitively.

- **Version**: `CLI Version` + semver, or `version`/`v` + semver.
- **OS**: `macOS`, `Windows`, `Linux`, `Ubuntu`, `Debian`, `darwin`, `win32`.
- **Auth**: `Auth Method`, `login`, `qwen-oauth`, `api config`, `oauth`.

If any are missing, add `status/need-information` and ask only for missing
facts. If already has `status/need-information` or bot missing-info comment,
do not post another.

## Version Staleness

```bash
node -p "require('./packages/cli/package.json').version"
gh release list --repo QwenLM/qwen-code --limit 20 --json tagName,publishedAt
```

If the reported version is ≥6 stable releases behind (match
`^v?[0-9]+\.[0-9]+\.[0-9]+$`, ignore SDK/preview/nightly tags), add
`status/need-retesting` and ask to upgrade and retest.

## Related And Duplicate

Search order: exact error text → command/feature name → stack trace file →
symptom keywords.

```bash
gh issue list --repo QwenLM/qwen-code --state all \
  --search "<terms>" --limit 10 \
  --json number,title,state,labels,updatedAt
```

Duplicate = same root cause or maintainer-confirmed. Related = similar area
with useful context. Prefer "related" when confidence is below duplicate.

## Auto-Fix Eligibility

All must be true: root cause high-confidence, fix ≤3 files, change is
mechanical, existing tests cover the area, no product decision needed.
Action: ask whether to run `/qc bugfix <issue-number>`.

## Welcome-PR Eligibility

For bugs: root cause identified, fix describable, change modest, test path
known, no deep architectural knowledge needed.

For features: product direction `aligned`, implementation boundary
self-contained, acceptance criteria stateable without maintainer decision.

Do not use merely because the requester offered to help.
