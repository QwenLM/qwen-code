# Web Shell BTW composer entry

[English](web-shell-btw-composer-entry.md) | [简体中文](web-shell-btw-composer-entry.zh-CN.md)

## Problem and current behavior

The main Web Shell chat supports `/btw <question>` and displays its answer in
an existing temporary panel. Users must know the command or receive an
automatic intent suggestion; the composer has no explicit entry. `/btw side`
is a separate, existing side-task command.

## Proposed solution

Add “Ask a side question” to the main composer's Add menu on desktop and
mobile. Show `/btw` and a compact, single-line hint: “Keep the main task running”
in English and “临时提问，不打断任务” in Chinese.
The answer stays out of the main conversation. Selecting it prefixes the current
text with `/btw ` and returns focus to the editor, without submitting. An
existing `/btw` prefix is preserved, with uppercase spellings normalized to
lowercase for the command router. The user can edit or remove the prefix.

Expose the entry only when a main-chat session exists and the host has not
hidden `btw` through `hiddenSlashCommands`. Keep it available
while a main prompt runs. Hide it in shell mode and disable it with an
explanation when images, files, composer tags, or pending image ingestion
are present, since BTW accepts a text question. Existing preparation and
composer-disabled states continue to block interaction.

## Decisions and scope

Reuse AddMenu's existing dropdown/drawer and deferred focus restoration.
Keep the text itself as the mode indicator; add no persistent mode, shortcut,
public customization option, daemon route, or new submission path. The main
App opts its ChatEditor into the entry. ChatPane does not opt in because it
has a different command router and no local BTW answer panel.

Affected files are App.tsx, ChatEditor.tsx, composer/AddMenu.tsx, i18n.tsx,
and focused composer/browser tests, all under packages/web-shell/client.
The existing `/btw` and `/btw side` routing remains authoritative.

## Validation and acceptance criteria

- The menu explains BTW in English and Chinese on desktop and mobile.
- Empty and existing drafts gain one `/btw` prefix; selection does not send.
- Already lowercase-prefixed drafts remain unchanged; uppercase prefixes are
  normalized. The editor regains focus.
- An ordinary question submitted after selection reaches the existing BTW
  endpoint and answer panel, without submitting or cancelling the main task.
- Attachments cannot be discarded by the action; shell and unavailable
  composer states do not expose an actionable entry.
- Focused tests, build, typecheck, and browser tests pass. The E2E plan records
  any environment limitations and distinguishes mocked transport from a real
  model call.

## Open questions

None for this scope. A separate input mode or ChatPane BTW panel can be
considered independently if needed.
