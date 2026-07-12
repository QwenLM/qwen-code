# AI-assisted release notes

## Problem

Stable GitHub releases currently use GitHub's generated release notes. The
result is complete and auditable, but it is a flat list of pull request titles.
`CHANGELOG.md` parses the same list and groups it by conventional-commit type,
so it does not add a user-facing explanation of what a release means.

## Goals

- Add a short, user-facing highlights section to stable releases.
- Preserve one complete, linked entry for every included pull request.
- Use pull request context instead of relying on commit subjects alone.
- Keep nightly and preview release behavior unchanged.
- Never block publication because an AI request failed.
- Use the same curated content for GitHub Releases and `CHANGELOG.md`.

## Non-goals

- Replacing version calculation or the existing release workflow.
- Letting a model decide whether a merged pull request is omitted.
- Curating historical releases that have already been published.
- Sending full diffs to the model by default.

## Design

The generator first asks GitHub for the release notes it would normally
generate for the current tag range. This body is both the fallback output and
the authoritative pull request set. The generator extracts each pull request
number, then fetches structured metadata for those pull requests: title, body,
labels, changed paths, and diff statistics.

Classification is deterministic. Conventional title prefixes and labels map
each pull request into Features, Bug Fixes, Performance, Documentation, or
Internal Changes. AI does not control inclusion or category membership.

The model receives compact pull request context in bounded batches. It returns
JSON containing exactly one user-facing summary per requested pull request.
The generator rejects a batch if it contains an unknown or duplicate pull
request number, and fills missing or rejected summaries with the original pull
request title. A final model call receives the validated summaries and selects
three to six highlights. Highlight references must also point to pull requests
in the authoritative set.

The renderer writes a versioned marker, Highlights, Breaking Changes, and a
complete categorized list. Every list item retains its pull request link. The
existing changelog generator recognizes the marker and reuses the curated body,
demoting headings beneath the changelog version heading. Older GitHub-generated
release bodies continue through the existing parser unchanged.

## Failure handling

Missing model configuration, HTTP errors, invalid JSON, or schema-validation
errors degrade to original pull request titles and no generated highlights.
Failure to produce the base GitHub notes remains a script failure; the workflow
then falls back to `gh release create --generate-notes`. Publication is never
blocked by the enhancement.

Pull request text is untrusted data. The generator calls an OpenAI-compatible
completion endpoint directly without agent tools, shell access, or repository
write access. Prompts explicitly delimit the data, and output is validated
before rendering.

## Verification

- Unit-test parsing, deterministic classification, validation, rendering, and
  fallback behavior with injected model responses.
- Unit-test that marked release bodies are preserved in `CHANGELOG.md` while
  historical bodies retain their current formatting.
- Assert that the stable workflow uses `--notes-file` when generation succeeds
  and retains `--generate-notes` for preview, nightly, and fallback paths.
- Dry-run the generator against a recent stable release's real pull request
  metadata and inspect the Markdown output.
