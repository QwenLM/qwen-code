# Plan: bilingual autofix failure-path handoff comments

Date: 2026-08-18
Design: `docs/design/2026-08-18-autofix-handoff-bilingual.md`

## Goal

Make every autofix failure-path handoff comment bilingual (English body
unchanged + collapsed `中文说明` details block), matching the convention the
rest of `qwen-autofix.yml` already follows.

## Architecture

- Agent contract: new `failure.zh.md` companion file (Chinese translation of
  `failure.md`), plain Markdown, no HTML.
- Workflow: `HEADLINE_ZH` sibling variable at every `HEADLINE` site; report
  block emits a `<details>` section before the Run log line; 3000-byte
  truncated + sanitized Chinese excerpt.
- Skill: SKILL.md bilingual rule extended.
- Tests: contract pins in `scripts/tests/qwen-autofix-workflow.test.js`.

## Files

| File                                          | Change                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/qwen-autofix.yml`          | HEADLINE_ZH at ~9 template sites (+ clause variants); report-block details section; zh excerpt truncation/escaping |
| `.qwen/skills/autofix/SKILL.md`               | bilingual rule: `failure.zh.md` companion requirement + constraints                                                |
| `scripts/tests/qwen-autofix-workflow.test.js` | contract pins: details block present, HEADLINE/HEADLINE_ZH pairing, SKILL rule pin                                 |

## Tasks

- [x] Create branch `feat/autofix-handoff-bilingual` from `origin/main`
- [x] Commit design + plan docs
- [x] yml: add HEADLINE_ZH (+ GATE_CLAUSE_ZH / CAUSE_ZH / LAST_FIX_ZH /
      IDLE_CLAUSE_ZH / REMEDY_ZH) at every HEADLINE assignment
- [x] yml: report block — emit details section (headline ZH, section labels
      ZH, failure.zh.md excerpt with 3000B truncation + iconv + sed
      escaping, gate-rejection note, graceful absence); also the
      develop-issue withdraw comment; failure.zh.md added to all cleanup
      and artifact lists
- [x] SKILL.md: extend bilingual-outputs rule with failure.zh.md contract
- [x] Tests: extend handoff-comment contract block; run focused vitest
- [x] Self-audit full diff (two clean passes), then offer to push/open PR

## Verification

- `npx vitest run --config ./scripts/tests/vitest.config.ts
qwen-autofix-workflow.test.js qwen-fleet-shepherd-workflow.test.js` —
  all green except two pre-existing local-environment failures (macOS bash
  3.2 lacks `mapfile` for the gate script; confirmed failing on the clean
  tree via stash)
- YAML parse (PyYAML) + `bash -n` over all 58 run blocks
- Smoke tests: zh excerpt sanitization (`<details`/`</details`/`<summary`/
  `<!--` neutralized), mid-character truncation under `set -eo pipefail`,
  three render scenarios (zh + gate-rejection / no zh / committed-not-pushed)
- Manual render check: assemble a sample report.md locally and eyeball the
  GitHub Markdown rendering of the details block
