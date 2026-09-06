# Privacy Policy — Qwen Code Chrome Extension

Last updated: 2026-07-30

## Summary

The Qwen Code Chrome Extension ("the Extension") bridges the Chrome browser with a locally running Qwen Code daemon process on your machine. The Extension itself does **not** collect, transmit, or share your personal data with any external server — all of its own communication stays on `localhost` / `127.0.0.1`. However, the local daemon it talks to may send page content to the AI model provider you configure; see [What the daemon does with page content](#what-the-daemon-does-with-page-content).

## What data the Extension accesses

| Permission  | Purpose                                                                                               | Data handled                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `tabs`      | Select the active tab and read its URL and title for AI-assisted browser automation                   | Active tab metadata — sent only to your local daemon                                                                           |
| `debugger`  | Attach Chrome DevTools Protocol (CDP) to the active tab so the local daemon can drive browser actions | CDP commands/responses — the attached tab's DOM/text, console output, network activity, and cookies, sent to your local daemon |
| `storage`   | Persist extension configuration (daemon address, optional bearer token)                               | Key-value settings only, no browsing data                                                                                      |
| `alarms`    | Schedule periodic connection health checks to the local daemon                                        | No user data                                                                                                                   |
| `sidePanel` | Display the extension's side panel UI                                                                 | No data access beyond rendering UI                                                                                             |

## Where data goes

- **Nowhere external _from the Extension_.** The Extension's `host_permissions` are restricted to `http://127.0.0.1/*` and `http://localhost/*` — it can only talk to a daemon process running on your own machine.
- Tab content and CDP traffic are forwarded **exclusively** to `127.0.0.1` / `localhost` on a port you configure.
- No analytics, no telemetry, and no third-party endpoints _in the Extension itself_.

### What the daemon does with page content

The Extension only ever talks to localhost, but understand the wider system before you enable browser automation:

- Through the `debugger` permission the local daemon can read the attached tab's **page DOM/text, console output, network activity, and cookies**, and can drive actions on the page.
- The daemon forwards that page content to the **AI model provider you have configured** in Qwen Code (for example an OpenAI-, Anthropic-, or Alibaba-hosted endpoint) so the model can act on it. Page content therefore **leaves your machine** as part of ordinary model requests.
- "Stays on localhost" describes the Extension's own network boundary; it does **not** describe the daemon-to-model-provider path. Only enable browser automation with a model provider you trust to receive the content of the pages you automate.

## Data storage

- The Extension stores only configuration keys (daemon address and an optional bearer token) in `chrome.storage`.
- No browsing history, page content, or personal information is persisted by the Extension.

## Data sharing

- The Extension does **not** share data with any third party.
- There is no account, login, or cloud service involved.

## User control

- You can uninstall the Extension at any time via `chrome://extensions`.
- You can review and revoke all permissions via Chrome's site settings.
- Clearing extension storage removes all persisted configuration.

## Contact

For questions about this policy, open an issue at the [project repository](https://github.com/QwenLM/qwen-code).
