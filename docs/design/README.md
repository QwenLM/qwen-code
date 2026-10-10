# Design Documentation Requirements

[English](README.md) | [简体中文](README.zh-CN.md)

Design documents describe proposed changes, their rationale, and how to verify
them. Store them under `docs/design/` and follow the requirements below when
creating or updating a design.

## File naming and navigation

- Maintain two complete versions in the same directory: `<name>.md` for English
  and `<name>.zh-CN.md` for Simplified Chinese. Keep the same base name and date
  prefix, if any. Directory entry pages use `README.md` and `README.zh-CN.md`.
- Add relative links to both versions immediately below each document title.
- Preserve existing document paths where possible. If a path or heading anchor
  changes, update its incoming references in the same change.

## Content alignment

- Both versions must cover the full design. A summary or a link to the other
  language does not replace a translation.
- Keep section order and heading levels aligned. Match the meaning of the
  problem statement, current state, goals, scope boundaries, proposed solution,
  design decisions and rationale, constraints, risks, validation plan, acceptance
  criteria, and open questions wherever those sections apply.
- Preserve technical identifiers, file paths, commands, configuration keys,
  protocol fields, example values, and numeric limits. Translate explanatory
  prose and captions without changing the behavior they describe.
- Keep status, dates, milestones, and follow-up requirements aligned when
  present. Distinguish proposals, implemented behavior, and verified results in
  both languages; translation must not change a design's status.
- Share diagrams and other assets where practical. Provide equivalent
  explanations for language-specific text in shared assets.

## Requirements for subsequent changes

- Create or update both versions in the same change and submit them together in
  the same PR. Either language may be edited first; reconcile any differences
  before considering the documentation complete.
- When updating an existing single-language design, add the missing version and
  align the complete pair. Preserve the original design's meaning when
  translating; explain actual design changes consistently in both versions.
- Reflect new decisions, implementation constraints, acceptance criteria, and
  follow-up work in both versions as the design evolves. Do not leave one
  version with an earlier requirement or an unresolved question that the other
  version has already answered.

## Review checklist

- Both files exist, and their language links resolve in both directions.
- Section structure and substantive requirements match; neither version omits
  decisions, limitations, acceptance criteria, or follow-up work.
- Technical identifiers, examples, links, and shared assets remain correct.
- Both versions reflect the same status and the changes proposed in the PR.
- Markdown formatting and relative links have been checked.
