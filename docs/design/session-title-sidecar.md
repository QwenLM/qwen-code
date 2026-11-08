# Session title sidecar

[English](session-title-sidecar.md) | [简体中文](session-title-sidecar.zh-CN.md)

Status: implemented. Date: 2026-11-04.

## Problem

A session's sidebar label is derived exclusively from its transcript: the
server takes `customTitle` from a `custom_title` record, or falls back to the
first user prompt scanned from the first ten records. When a transcript is
recreated without its head — a missing file recreated by the writer on the next
append, or a crash-truncated file — the first prompt is gone and `displayName`
becomes empty. The Web Shell then falls back to the first eight characters of
the session id, which is not a name.

A sidecar cannot cover a directory that is deleted wholesale: the label lives
next to the transcript, so an external clear of the chats directory removes
both and the session still needs a manual rename.

Observed case: a live session whose transcript file was recreated at 15:57 kept
only `ui_telemetry` and background-task notifications. Its list row showed
`9d68a0dc` although the session had been created with a normal prompt.

## Goals

- Keep the list label available when a transcript loses its head.
- Preserve a user-chosen name across transcript rebuilds.
- Stop rendering a bare session id as a session name.

## Non-goals

- Reconstructing history from a transcript that no longer exists.
- Changing how `custom_title` records are stored in the transcript.
- Renaming or searching behavior for sessions that never had a name.

## Proposed solution

Add a per-session sidecar next to the transcript:

```
<projectDir>/chats/<sessionId>.title.json
```

```json
{
  "version": 1,
  "displayName": "CI 验证与复验",
  "source": "prompt",
  "updatedAt": "2026-11-04T09:44:49.085Z"
}
```

`source` is one of `prompt`, `auto`, or `manual`.

### Write points

- `ChatRecordingService.recordUserMessage` writes the first real user prompt as
  `source: "prompt"`, using the same 200-code-point-plus-ellipsis policy the
  list reader applies (`truncateTitleForList`) and the same label-selection
  policy: an explicitly empty `displayText` projection offers nothing and lets a
  later prompt label the session, a record without a projection falls back to
  its text parts, and a Mod-submitted prompt is not filtered out. Later prompts
  do not overwrite it, and a first prompt with no text part (image only)
  produces no label.
- `ChatRecordingService.recordCustomTitle` writes the custom title with its
  title source. A `prompt` entry never overwrites an `auto`/`manual` entry, so a
  rename survives a later prompt.
- `SessionService.renameSession` — the fallback used when no live recording is
  attached — writes the sidecar after appending its `custom_title` record.
- `ChatRecordingService` seeds the sidecar from a resumed transcript: the
  resolved custom title, otherwise the first recorded prompt label. Without
  this, sessions created before the sidecar existed would never gain one,
  because a resumed session does not record another first prompt. An existing
  `manual`/`auto` entry is never replaced by the seeded prompt.
- The projected restore carries no record stream, so it cannot recover the
  first prompt. A recorder that attached through it does not create a prompt
  label from a later prompt; the transcript still supplies the name while its
  head survives.
- `SessionService.forkSession` writes the new session's title sidecar after the
  forked transcript commits. Without an explicit fork title it copies the
  source's sidecar, so a branch of a headless source keeps the name the source
  still shows.
- Managed session logs are skipped: they own their metadata projection.

### Read points

- `SessionService.getSessionTitleInfo` / `getSessionTitle` return the custom
  title from a `manual`/`auto` sidecar when the transcript has none.
- `SessionService.listSessions` and `getSessionListItem` use the `prompt`
  sidecar when the transcript has no first prompt.
- `SessionService.getSessionDisplayName` falls back to the sidecar after a
  damaged transcript read or a transcript with no name. A transcript that is
  refused because it belongs to another project returns no name; the sidecar is
  not consulted, so another project's prompt text cannot leak through.
- Title lookups see the same names the rows show: `findSessionsByTitle`,
  `findSessionTitlesByPrefix` (the picker and its uniqueness scan), and the
  unarchive collision guard also accept a `manual`/`auto` sidecar name.
- The transcript remains authoritative: a `custom_title` record or a readable
  first prompt always wins.

### Lifecycle

- Archive / unarchive moves the sidecar with the transcript.
- Session deletion removes the active and archived sidecars.
- Moving session storage to a different runtime base directory includes the
  sidecar.

### Web Shell fallback

When `displayName` is empty, sidebar rows render the localized
`sidebar.untitledSession` label (“Untitled session” / “未命名会话”) instead of
the id prefix. Search matching and delete confirmation still use the id
fallback, because the id is the only stable identifier there.

## Design decisions

- **A sidecar instead of rewriting the transcript.** Re-inserting a prompt
  record would fabricate conversation history the model could replay. A
  sidecar is metadata only.
- **Only the first prompt is stored.** Storing every prompt would duplicate the
  transcript and enlarge the chats directory. The first prompt is the label the
  list already uses.
- **Best-effort writes.** A failed sidecar write must never fail a prompt or a
  rename; missing sidecars are treated as “no persisted label”.
- **A sidecar read only when the transcript cannot supply a field.** The list
  paths skip the sidecar only when the transcript yields both a custom title and
  a first prompt; if either is missing they read it, because the sidecar can
  supply the rename and the prompt label independently.

## Risks

- A sidecar can disagree with the transcript after a partial write. Reads prefer
  the transcript, so the visible name remains the authoritative one.
- The sidecar contains the first prompt, which may include sensitive text.
  It lives next to the transcript (mode `0600`) with the same exposure.
- Orphan sidecars can remain if a session is deleted outside the service. They
  are ignored by the session scanner, which only accepts `<uuid>.jsonl`.

## Validation

- Unit tests cover round-trip/validation, transcript-headless list fallback,
  rename preference, session deletion in both archive states, the archived list
  reader, first-prompt/custom-title writes, the shared write/read filesystem,
  the fork copy, title lookup from the sidecar, membership and read-error
  handling, and the resume policies above.
- Real daemon scenario: start an isolated `qwen serve` with a fake
  OpenAI-compatible endpoint, send a prompt, replace the transcript with a
  single `ui_telemetry` record, restart the daemon, and confirm the list still
  shows the prompt-derived name. Then rename the session, replace the transcript
  again, restart, and confirm the manual name survives with
  `titleSource: "manual"`.

## Acceptance criteria

- A headless or recreated transcript no longer produces an empty `displayName`
  for a session that had a first prompt or a custom title, as long as the chats
  directory itself still exists.
- A manual rename survives a transcript rebuild or truncation.
- A session with no sidecar renders a neutral label, not an id prefix.
- Archive, unarchive, and delete keep sidecar state consistent with the
  transcript.
