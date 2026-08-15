---
name: qwen-webbridge
description: Control the user's real Chrome browser with its existing tabs and login sessions. Use for navigating websites, reading pages, clicking, typing, screenshots, PDFs, uploads, network inspection, or any browser task when the Qwen Chrome extension is connected.
allowedTools:
  - read_file
---

# Qwen WebBridge

Use the local `qwen serve` WebBridge API to control the user's real Chrome. It does not require MCP or a separate Chrome DevTools adapter.

The daemon provides `QWEN_WEBBRIDGE_URL` and a route-scoped `QWEN_WEBBRIDGE_TOKEN` to its agent processes. Send `Authorization: Bearer $QWEN_WEBBRIDGE_TOKEN` with every HTTP request. If either value is missing, the current CLI process was not launched by the daemon and cannot use this WebBridge instance.

## Before the first action

Call `GET /status`. Continue only when `extension_connected` is `true`. If the daemon is unavailable, tell the user to start `qwen serve` with the Chrome extension origin shown in its side panel. If the daemon is running but the extension is disconnected, tell the user to load the Qwen Code extension and use that same origin.

## Command format

Send JSON to `POST /command`:

```json
{
  "action": "navigate",
  "args": {
    "url": "https://example.com",
    "newTab": true,
    "group_title": "Research"
  },
  "session": "research-550e8400-e29b-41d4-a716-446655440000"
}
```

Shell commands and file writes below are ordinary tool calls and follow the session's approval rules; expect approval prompts unless the user has granted narrower allow rules. Do not ask the user to add broad allow rules for this skill.

Use one stable session name with a fresh UUID suffix for the entire user task. The first `navigate` should normally use `newTab:true` and a human-readable `group_title`. At the end, call `close_session` with `close_tabs:false` to release browser state while preserving tabs. Omit `close_tabs:false` only when the user asks to close the task's tabs.

Prefer writing request JSON with `write_file`, posting it with an explicit JSON content type, then deleting that temporary request file. This preserves Unicode and avoids shell quoting errors:

```bash
WEBBRIDGE_BASE=$QWEN_WEBBRIDGE_URL
curl -sS -X POST "$WEBBRIDGE_BASE/command" \
  -H "Authorization: Bearer $QWEN_WEBBRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/absolute/path/to/request.json
```

On Windows, use `curl.exe`, a uniquely named JSON file under `$env:TEMP` (PowerShell) or `%TEMP%` (cmd.exe), and delete it after the request.

## Actions

| Action          | Args                                                                      | Result                                                                          |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `navigate`      | `url`, optional `newTab`, `group_title`                                   | `{success,url,tabId}`                                                           |
| `find_tab`      | `url`, optional `active`                                                  | Selects a session tab; `active:true` borrows the user's foreground matching tab |
| `list_tabs`     | none                                                                      | Session-owned tabs                                                              |
| `close_tab`     | none                                                                      | Closes the current session tab                                                  |
| `close_session` | optional `close_tabs` (default `true`)                                    | Closes owned tabs, or releases state while preserving tabs when `false`         |
| `snapshot`      | none                                                                      | Accessibility tree with `@e` element refs                                       |
| `click`         | `selector` (`@e` or CSS)                                                  | DOM-level click                                                                 |
| `fill`          | `selector`, `value`                                                       | Replaces input, textarea, or contenteditable text                               |
| `mouse_click`   | `selector` (`@e` or CSS)                                                  | CDP mouse click at the element center                                           |
| `evaluate`      | `code`                                                                    | Awaited JavaScript result                                                       |
| `key_type`      | `text`                                                                    | CDP text insertion                                                              |
| `send_keys`     | `keys`, optional `repeat`                                                 | CDP key sequences such as `Enter`, `Mod+A`, or `Shift+Tab`                      |
| `network`       | `cmd` (`start`, `stop`, `list`, `detail`), optional `filter`, `requestId` | Request metadata and response bodies                                            |
| `cdp`           | `method`, optional `params`                                               | Raw CDP result                                                                  |
| `screenshot`    | optional `format`, `quality`, `selector`                                  | Temporary local image path and metadata                                         |
| `save_as_pdf`   | optional `paper_format`, `landscape`, `scale`, `print_background`         | Temporary local PDF path and metadata                                           |
| `upload`        | `selector`, `files`                                                       | Sets local paths on a file input                                                |

Use `snapshot` and its `@e` refs before reaching for CSS selectors or JavaScript. Use `mouse_click`, `key_type`, and `send_keys` when a page needs CDP-level input. `click` and `fill` are DOM-synthetic and may be rejected by sites that require trusted events. Top-frame actions do not enter cross-origin iframes.

For screenshots and PDFs, open the returned local `path` with `read_file`; the API never returns base64 to the model. `network detail` and `upload` can expose sensitive data, so keep their use within the user's stated task.
