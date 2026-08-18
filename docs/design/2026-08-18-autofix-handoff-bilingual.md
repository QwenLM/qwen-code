# Bilingual autofix failure-path handoff comments

Date: 2026-08-18
Status: draft — awaiting maintainer sign-off

## Motivation

The autofix loop's failure-path handoff comments (e.g. the round-6
growth-brake escalation on PR #9262, comment 5321766307) are English-only.
Every other static comment the workflow posts — takeover acks, re-arm,
dispatch refusal, milestone, base-updated, review-deferred — is already
bilingual (English first, Chinese in a collapsed
`<details><summary>中文说明</summary>` block). The handoff comments are the
ones that most need Chinese: they stop the loop and ask a maintainer to make
a decision (split / redesign / accept-residuals), and a Chinese-speaking
maintainer should be able to act on them without translating a wall of
English first.

## How the comment is assembled today

`qwen-autofix.yml`, failure path of the `Address review feedback` job
(~L6660–7050), builds `<workdir>/report.md` and posts it with `gh pr comment`:

1. `HEADLINE` — one of ~9 bash-generated English templates:
   - API-error / timeout / crash / gate-crash, retry and terminal forms
     (CAUSE × 4, LAST_FIX × 5, composed into two sentence frames);
   - stale-base auto-update retry;
   - needs-a-human handoff ("Could not produce a passing fix…") with
     GATE_CLAUSE × 5 (none / gate rejected / pre-existing × 3 compare
     states);
   - could-not-start (setup failure retry; round cap);
   - terminal crash before reading feedback;
   - consecutive-failure breaker;
   - cumulative-timeout breaker (IDLE_CLAUSE and REMEDY variants).
2. Optional excerpt: `**What I found before stopping:**` (or the NOT-pushed
   warning) + the first 1500 bytes of `DETAIL_FILE` — the first non-empty of
   `failure.md`, `handoff.md`, `address-summary.md`, `no-action.md` —
   passed through `iconv -c` and `<!--` escaping.
3. Optional gate-rejection section: `**Why it was not pushed:**` + up to
   3900 bytes of `gate-rejection.md` (written by `reject_fix()` in
   `.github/scripts/run-autofix-review-verification.sh`; static reason
   sentence + untranslatable log evidence), fenced by
   `<!-- autofix-gate-rejection-start/end -->`.
4. Footer: Run log link, `🧠 Handled by Qwen Code` signature, and the
   `autofix-eval` / `autofix-growth-now` / `autofix-redcheck` markers. The
   next scan parses these markers out of the raw comment body.

Agent-written `failure.md` is the content of the decision-relevant part
(options, recommendation). SKILL.md currently mandates `failure.md` and
`handoff.md` stay English-only WITHOUT a details block, because the comment
embeds a byte-truncated excerpt: a severed `<details>` tag would swallow the
rest of the rendered comment.

## Design

### 1. New agent output: `failure.zh.md`

Whenever the agent writes `<workdir>/failure.md`, it must also write
`<workdir>/failure.zh.md` — a complete paragraph-by-paragraph Chinese
translation. Constraints encoded in SKILL.md's GitHub Actions Rules:

- plain Markdown; no HTML tags at all (no `<details>`, no `<summary>`);
- no `<!--` sequences;
- the workflow, not the agent, owns the surrounding `<details>` wrapper.

`failure.md` itself stays English-only (excerpt-safety unchanged).
`handoff.md` remains run-agent.mjs-owned and English-only.

### 2. Parallel Chinese headline variables

Every `HEADLINE=` assignment gains a `HEADLINE_ZH=` sibling (~23 static
strings total, including the CAUSE / LAST_FIX / GATE_CLAUSE clause
variants). Same composition shape as the English side, e.g. the needs-human
path:

```
HEADLINE_ZH="🤖 未能为该反馈产生通过验证的修复（第 ${MARK_ROUND}/${MAX_ROUNDS} 轮）${GATE_CLAUSE_ZH}。此项现在需要人工处理；循环保持在线，仍会拾取新反馈与 base 冲突，但不会自行重试此项。"
```

Precedent for parallel `_ZH` variables already exists in the workflow
(`WIN_DESC_ZH` in the milestone comment).

Section labels inside the report block also gain Chinese counterparts used
only inside the details block (`**What I found before stopping:**`, the
NOT-pushed warning, the no-detail fallback sentence, `**Why it was not
pushed:**`, the stale-base note).

### 3. Report layout

English body unchanged. Immediately before the `Run log:` line, insert:

```markdown
<details>
<summary>中文说明</summary>

${HEADLINE_ZH}

**停止前我了解到的情况：**
[excerpt of failure.zh.md — only when the file exists]

[one line: gate-rejection evidence stays English, see above — only when
gate-rejection.md is present]

</details>
```

Markers stay last and ASCII-untouched, so the next scan's parsing is
unaffected. The wrapper tags are emitted by the workflow, so a truncated
translation can lose content but can never swallow the comment tail.

### 4. Truncation and sanitization of the Chinese excerpt

`head -c 3000` (Chinese is ~3 bytes/char, so ≈1000 chars — roughly the same
information as the 1500-byte English excerpt), then `iconv -f utf-8 -t
utf-8 -c`, then sed escaping: `<!--` (as today) plus `<details`,
`</details`, `<summary` → full-width `＜` forms, so a pathological
translation quoting markup cannot break the wrapper. `<workdir>` style
angle-bracket prose stays intact.

Budget knobs live next to the existing 1500/3900 constants with a comment.

### 5. Degradation

- `failure.zh.md` missing (run-agent.mjs wrote `failure.md` itself on crash
  / loop-guard / missing-output paths; or the agent skipped it) → the
  details block still renders `HEADLINE_ZH` alone. Never fail the round
  over a missing translation.
- `DETAIL_FILE` = `address-summary.md` / `no-action.md` (already bilingual
  by SKILL contract) → those files have no `failure.zh.md` sibling;
  headline-only details block is correct for them too.

### 6. SKILL.md changes

In GitHub Actions Rules, extend the bilingual-outputs rule: keep the
English-only requirement for `failure.md`/`handoff.md`, add the
`failure.zh.md` companion requirement with the constraints above. The
growth-brake handoff directive (workflow feedback.md text and SKILL's
defer-to-human item) relies on the general rule — no per-mode repetition.

### 7. Contract tests (`scripts/tests/qwen-autofix-workflow.test.js`)

Extend the existing handoff-comment describe block (~L13086):

- needs-human report contains the `中文说明` details block and the Chinese
  headline;
- every HEADLINE assignment in the workflow has a sibling HEADLINE_ZH
  (static structural pin, same style as the existing headline pins);
- SKILL.md pin: `failure.zh.md` companion rule present; `failure.md`
  remains English-only.

## Out of scope (follow-ups)

- `gate-rejection.md` body translation — evidence is log output; the
  translated GATE_CLAUSE already tells a Chinese reader the gate rejected
  the attempt. (Maintainer default; veto before sign-off if wanted.)
- `qwen-fleet-shepherd.yml` escalation comments — separate workflow.
- run-agent.mjs's own `handoff.md` preface lines (rare fallback path).

## Risks

- ~23 new static Chinese strings in a 7k-line workflow: review burden is
  real but mechanical; contract tests pin presence, not prose quality.
- Agent may skip `failure.zh.md` under budget pressure → degraded but
  functional (headline-only details). No round outcome changes.
- Comment size grows by ≤ ~3.5 KB; far under GitHub's 65 KB limit.
