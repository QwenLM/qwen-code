# Privacy Policy — Qwen Code Chrome Extension

Last updated: 2026-09-03

## Summary

The Qwen Code Chrome Extension ("the Extension") bridges Chrome with locally running Qwen Code processes on your machine. The Extension itself does **not** collect, transmit, or share your personal data with an external server: its own communication uses `localhost` / `127.0.0.1` or Chrome Native Messaging. Qwen Code may send browser data to the AI model provider you configure; see [What Qwen Code does with browser data](#what-qwen-code-does-with-browser-data).

## What data the Extension accesses

| Permission        | Purpose                                                                                       | Data handled                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tabs`            | List open HTTP(S) tabs and read their URL and title for AI-assisted browser automation        | Open-tab metadata — sent only to the local Browser Use process                                                               |
| `debugger`        | Attach Chrome DevTools Protocol (CDP) to a claimed tab so Qwen Code can drive browser actions | CDP commands/responses — the attached tab's DOM/text, console output, network activity, and cookies, sent to a local process |
| `history`         | Search browsing history when a Browser Use task explicitly needs it                           | Matching URLs, titles, and visit times — sent only to the local Browser Use process                                          |
| `nativeMessaging` | Connect the extension to the local Browser Use process                                        | Browser commands and results exchanged with a native host on this machine                                                    |
| `storage`         | Persist extension configuration and transient Browser Use tab state                           | Configuration, owned-tab identifiers, and tab-group identifiers                                                              |
| `tabGroups`       | Group tabs created by Browser Use and label the active session                                | Group identifiers and the Browser Use session name                                                                           |
| `alarms`          | Schedule periodic connection health checks to the local daemon                                | No user data                                                                                                                 |
| `sidePanel`       | Display the extension's side panel UI                                                         | No data access beyond rendering UI                                                                                           |

## Where data goes

- **Nowhere external _from the Extension_.** The Extension's `host_permissions` are restricted to `http://127.0.0.1/*` and `http://localhost/*` — it can only talk to a daemon process running on your own machine.
- Tab content and CDP traffic are forwarded **exclusively** to a local Qwen process through `127.0.0.1` / `localhost` or Chrome Native Messaging.
- No analytics, no telemetry, and no third-party endpoints _in the Extension itself_.

### What Qwen Code does with browser data

The Extension only communicates with local processes, but understand the wider system before you use browser automation:

- Through the `debugger` permission the local daemon can read the attached tab's **page DOM/text, console output, network activity, and cookies**, and can drive actions on the page.
- Through the `history` permission Browser Use can search matching URLs, titles, and visit times. Those results can be included in model requests when a task uses them.
- The daemon forwards that page content to the **AI model provider you have configured** in Qwen Code (for example an OpenAI-, Anthropic-, or Alibaba-hosted endpoint) so the model can act on it. Page content therefore **leaves your machine** as part of ordinary model requests.
- "Stays local" describes the Extension's own communication boundary; it does **not** describe the Qwen Code-to-model-provider path. Only use browser automation with a model provider you trust to receive the browser data needed by the task.

## Data storage

- The Extension stores configuration plus transient Browser Use session state such as owned-tab and tab-group identifiers in `chrome.storage`.
- No browsing history, page content, or personal information is persisted by the Extension.

## Data sharing

- The Extension does **not** share data with any third party.
- There is no account, login, or cloud service involved.

## User control

- Chrome shows the Extension's declared permissions during installation or an update that adds new warning permissions.
- You can disable or uninstall the Extension at any time via `chrome://extensions` to remove Browser Use access.
- Clearing extension storage removes all persisted configuration.

## Contact

For questions about this policy, open an issue at the [project repository](https://github.com/QwenLM/qwen-code).
