# User-Facing Release Notes

## Problem

Stable release notes are a developer-facing PR list. `finalize-release.yml`
runs `scripts/generate-release-notes.js`, which buckets every merged PR into
commit-type sections (Features / Bug Fixes / Performance / Documentation /
Internal Changes) and rewrites each entry with a one-sentence model summary.
For users this reads as a wall of PRs:

- Entries are grouped by change _type_, not by the area a user cares about
  (Web Shell, Desktop, multi-agent, model support).
- Styles mix: model sentences ("Adds standard OpenTelemetry…") sit next to
  raw conventional-commit titles ("feat(serve): bound daemon ACP NDJSON
  buffers") whenever a summary fell back, which reads as unedited tooling
  output.
- Highlights repeat full-list entries nearly verbatim, adding length without
  a second level of abstraction.
- No Chinese version, despite a large Chinese-speaking user base.
- UI changes ship without visuals even when the PR body already carries
  Before/After screenshots.

Measured context (2026-08-15): v0.21.11 listed 49 PRs; only 2 of those PR
bodies contain images (~4%), and 3 of the last 60 merged PRs overall. Image
support is therefore best-effort decoration, never structure.

## Goals

1. Replace the type-bucketed PR list with a **themed digest**: model groups
   changes into user-facing themes, each with a short intro and items.
2. Add a **Chinese digest** mirroring highlights and themes (PR-level list
   stays English; PR titles are English by convention).
3. **Attach screenshots** from PR bodies to digest items when available,
   degrade silently when not.
4. Lose no information and no robustness: the full PR list remains as a
   collapsed appendix, and every model failure path keeps today's output.

## Non-Goals

- Translating the full PR list into Chinese.
- Changing nightly/preview notes (they never run the AI path).
- Sourcing images from anywhere other than the merged PR body.
- Editing the GitHub Release creation step in `release.yml` (it still
  publishes GitHub-generated notes immediately; finalize rewrites later).

## Pipeline Recap

1. `release.yml` → `gh api …/releases/generate-notes` anchored at the
   previous tag → `cap-release-notes.mjs` → `gh release create`.
2. `finalize-release.yml` → `generate-release-notes.js` parses the
   GitHub-generated bullets, fetches PR bodies/labels via GraphQL, calls the
   model (summaries in batches of 8, then highlights), renders Markdown, and
   `gh release edit`s it in place. Marker: `<!-- qwen-release-notes:v1 -->`.
3. `npm run changelog` (`generate-changelog.js`) rebuilds CHANGELOG.md from
   the GitHub Releases API; bodies starting with the marker are embedded
   verbatim (headings demoted one level).

## Proposed Changes

### 1. Model content: summaries gain Chinese; new themes call

`scripts/generate-release-notes.js` keeps the batched summaries call and the
highlights call, and adds one **themes** call:

- Summaries response becomes
  `{"summaries":[{"pr","summary","summaryZh"}]}`. English rules unchanged
  (≤180 chars, plain text). `summaryZh` is Simplified Chinese, ≤120 chars,
  technical identifiers (commands, settings, product names) stay English.
  An invalid `summaryZh` falls back to the English summary for that entry
  with a warning — the Chinese section never drops wholesale.
- Highlights response gains `textZh` (same limits as `summaryZh`).
- New themes call input: every entry's number, category, English and Chinese
  summary. Response:

  ```json
  {
    "themes": [
      {
        "title": "Web Shell",
        "titleZh": "Web Shell",
        "intro": "…≤200 chars, optional…",
        "introZh": "…",
        "items": [8780, 8973]
      }
    ]
  }
  ```

  Validation mirrors the existing summary/highlight guards: ≤8 themes,
  title ≤40 chars, items reference known PRs, a PR appears in at most one
  theme. PRs the model leaves unassigned are collected into a deterministic
  catch-all theme rendered last ("Other Changes" / "其他变更").

All three calls share the existing retry/backoff/deadline machinery.
The themes call scales `max_tokens` with the entry count (capped at 8192);
summaries and highlights keep the fixed 4096 budget, which leaves headroom
for every reachable summaries batch (at most 8 entries × English + Chinese).

### 2. Rendering: v2 layout

```
<!-- qwen-release-notes:v2 -->

## Highlights

## Breaking Changes        ← bilingual when present: English item plus an
                            indented Chinese line ("No known breaking
                            changes." stays English-only)

## <Theme title>           ← intro + items; screenshots under items
## <Theme title> …

---

## 中文摘要

### 亮点                   ← Chinese highlights
### <theme titleZh>        ← introZh + Chinese items

<details><summary>Complete Change List (N pull requests)</summary>

### Features
- web-shell: improve compact tool activity ([#8973](…)) by @ytahdn
…
</details>

## New Contributors
**Full Changelog**: …compare/v0.21.11...v0.21.12
```

Decisions:

- **Block layout, not interleaved**: English digest on top, one `---`
  divider, then `## 中文摘要`. Each audience reads one contiguous block;
  GitHub's TOC and release page stay scannable.
- **Themes use `##`**, matching today's section weight; Chinese themes use
  `###` under the `## 中文摘要` umbrella.
- **Appendix uses normalized raw titles**, not model summaries: strip the
  `type(scope):` prefix to `scope: description` (same rule as
  `generate-changelog.js` `formatEntry`), keep ` by @author` and co-author
  credits. This kills the mixed-style problem deterministically and makes
  the appendix independent of model availability. Category sub-headings
  (Features / Bug Fixes / …) remain — the appendix is the developer view.
- **Highlights** keep the v1 shape (text + PR links); no bolding tricks,
  since highlight text already names the capability.
- Author attribution stays in the appendix only; digest items show just the
  text + PR link, keeping lines short.

### 3. Images from PR bodies

Deterministic extraction, no model involvement:

- Sources in the PR body (already fetched by the GraphQL query): Markdown
  `![alt](url)`, `<img src="url">`, and bare image URLs.
- Host allowlist (https only): `github.com/user-attachments/`,
  `user-images.githubusercontent.com`,
  `private-user-images.githubusercontent.com`, and `raw.githubusercontent.com`
  pinned to a 40-hex commit-SHA ref — a branch ref stays mutable after
  publication, so its owner could swap the image in a shipped release.
  Anything else is ignored — the release body must never become a hotlinking
  vector. The camo image proxy is deliberately not allowed even though GitHub
  serves it: its HMAC signs arbitrary external URLs without repository
  binding, so admitting it would re-admit every excluded host.
- First two matches per entry; first eight images per release; images render
  only under digest items (never in the collapsed appendix).

Measured coverage is ~4% of release PRs, so the extractor must be cheap and
its absence invisible: no images → identical output to the image-less case.

### 4. Fallback ladder

| Failure                        | Result                                |
| ------------------------------ | ------------------------------------- |
| No model config                | Today's v1 render (titles only)       |
| Summaries batch fails          | Circuit breaker as today; titles used |
| Highlights call fails          | Digest without a highlights section   |
| Themes call fails              | Whole note falls back to v1 render    |
| One `summaryZh` invalid        | That item shows English in 中文摘要   |
| A theme intro invalid          | Intro dropped; theme itself kept      |
| No Chinese produced anywhere   | 中文摘要 block omitted entirely       |
| Image extraction finds nothing | No image lines                        |

Every rung emits the existing `::warning::` annotations, so degradation is
visible in the Actions run without failing the release.

### 5. CHANGELOG.md handling

`generate-changelog.js` accepts markers `v1` and `v2`. For v2 bodies it:

- unwraps `<details><summary>…</summary>` into a heading and drops the
  closing tag (a text changelog has no collapse affordance); the heading is
  emitted at `##` so the demotion lands it at `###`, the same sibling rank
  v1's `## Complete Change List` reaches, keeping one skeleton across v1/v2
  releases in the same file,
- drops image lines and the `---` divider that precedes the Chinese
  digest (release-page chrome),
- otherwise applies the existing heading demotion.

v1 bodies keep today's verbatim embedding.

## Files Affected

| File                                           | Change                                      |
| ---------------------------------------------- | ------------------------------------------- |
| `scripts/generate-release-notes.js`            | prompts, themes call, extraction, v2 render |
| `scripts/generate-changelog.js`                | v2 marker + details/image transform         |
| `scripts/tests/generate-release-notes.test.js` | new coverage                                |
| `scripts/tests/generate-changelog.test.js`     | v2 embedding coverage                       |

No workflow, package.json, or `cap-release-notes.mjs` changes: the body
size stays far below the 120,000-char cap, and the script's CLI contract is
unchanged.

## Open Questions

None blocking. Chinese phrasing quality is prompt-controlled and reviewed
per release; if it disappoints, tightening the summaries prompt is a
follow-up, not a design change.
