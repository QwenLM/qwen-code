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

- [ ] Create branch `feat/autofix-handoff-bilingual` from `origin/main`
- [ ] Commit design + plan docs
- [ ] yml: add HEADLINE_ZH (+ GATE_CLAUSE_ZH / CAUSE_ZH / LAST_FIX_ZH /
      IDLE_CLAUSE_ZH / REMEDY_ZH) at every HEADLINE assignment
- [ ] yml: report block — emit details section (headline ZH, section labels
      ZH, failure.zh.md excerpt with 3000B truncation + iconv + sed
      escaping, gate-rejection note, graceful absence)
- [ ] SKILL.md: extend bilingual-outputs rule with failure.zh.md contract
- [ ] Tests: extend handoff-comment contract block; run focused vitest
- [ ] Self-audit full diff (two clean passes), then offer to push/open PR

## Verification

- `npx vitest run scripts/tests/qwen-autofix-workflow.test.js` (exact
  invocation confirmed at implementation time)
- `npx yamllint .github/workflows/qwen-autofix.yml` if config covers it
- Manual render check: assemble a sample report.md locally and eyeball the
  GitHub Markdown rendering of the details block
