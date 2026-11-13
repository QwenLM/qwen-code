# README Evaluation Presentation

[English](2026-10-14-readme-evaluation.md) | [简体中文](2026-10-14-readme-evaluation.zh-CN.md)

## Problem

The README expands evaluation configuration, a results table, and a large chart
before readers reach the ecosystem section. The chart's 76%–78% axis visually
amplifies the 1.40 percentage point spread across versions.

## Design

- Keep the existing evaluation heading and anchor. Show one sentence of benchmark
  context, a compact chart, and a link to the full results.
- Move all existing configuration and result values to linked English and Chinese
  evaluation documents under `docs/`.
- Use a compact line chart to show the version sequence. Widen the vertical axis
  to 70%–80% and label that range in the subtitle and ticks. Preserve release
  order and exact score labels; connect observed points with straight segments
  without smoothing. Use one Qwen purple accent, quiet grid lines, and readable
  text. Support light and dark backgrounds.
- Retain the existing SVG path so incoming image references continue to work.
  Include accessible title, description, and Markdown alternative text.
- Change presentation only. Do not update benchmark results or claim statistical
  significance, improvement, or results for untested releases.

## Validation and Acceptance Criteria

- The README evaluation section has no expanded tables or third-level headings.
- Both evaluation documents preserve every score and configuration value from
  the original README and have reciprocal language links.
- SVG point positions agree with the reported scores and labeled 70%–80% scale.
- Inspect rendered desktop and narrow views in light and dark themes; check
  labels, contrast, spacing, links, and an accessible table fallback.
- Check Markdown formatting, SVG syntax, and the full diff in two clean passes.
  Attempt the repository build and typecheck; report any environment limitation.

## Scope

This change affects repository documentation and its existing chart asset only.
It does not change CLI behavior and needs no CLI E2E plan or unit test.
