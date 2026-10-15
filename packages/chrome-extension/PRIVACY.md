# Privacy Policy — Qwen Code Chrome Extension

Last updated: 2026-09-20

## Summary

The Qwen Code Chrome Extension ("the Extension") bridges Chrome with locally running Qwen Code processes on your machine. Its own communication uses local loopback connections or Chrome Native Messaging. Qwen Code may send browser data to the AI model provider you configure; see [What Qwen Code does with browser data](#what-qwen-code-does-with-browser-data). This notice supplements the [Qwen Code privacy notice](../../docs/users/support/tos-privacy.md#chrome-extension-and-browser-use).

## What data the Extension accesses

| Permission        | Purpose                                                                                       | Data handled                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tabs`            | List open HTTP(S) tabs and read their URL and title for AI-assisted browser automation        | Open-tab metadata — sent only to the local Browser Use process                                                               |
| `debugger`        | Attach Chrome DevTools Protocol (CDP) to a claimed tab so Qwen Code can drive browser actions | CDP commands/responses — the attached tab's DOM/text, console output, network activity, and cookies, sent to a local process |
| `history`         | Search browsing history when a Browser Use task explicitly needs it                           | Matching URLs, titles, and visit times — sent only to the local Browser Use process                                          |
| `webNavigation`   | Associate tabs opened by a recent assistant action with the same browser session              | Navigation-source information and source/target tab identifiers                                                              |
| `nativeMessaging` | Connect the extension to the local Browser Use process                                        | Browser commands and results exchanged with a native host on this machine                                                    |
| `storage`         | Persist extension configuration and transient Browser Use tab state                           | Connection settings, optional daemon authentication token, browser-instance identifier, and tab/session ownership state      |
| `tabGroups`       | Group tabs created by Browser Use and label the active session                                | Group identifiers and the Browser Use session name                                                                           |
| `alarms`          | Schedule periodic connection health checks to the local daemon                                | No user data                                                                                                                 |
| `sidePanel`       | Display the extension's side panel UI                                                         | No data access beyond rendering UI                                                                                           |

## Where data goes

- The Extension connects to a daemon on your own machine using a loopback address. Its daemon configuration rejects remote hostnames.
- Tab content and CDP traffic are forwarded **exclusively** to a local Qwen process through `127.0.0.1` / `localhost` or Chrome Native Messaging.
- No analytics, no telemetry, and no third-party endpoints _in the Extension itself_.

### What Qwen Code does with browser data

The Extension only communicates with local processes, but understand the wider system before you use browser automation:

- Through the `debugger` permission the local daemon can read the attached tab's **page DOM/text, console output, network activity, and cookies**, and can drive actions on the page.
- Through the `history` permission Browser Use can search matching URLs, titles, and visit times. Those results can be included in model requests when a task uses them.
- Browser results can include screenshots and interaction results. Depending on the pages and tasks you choose, page content or debugging results may include personal identifiers, health information, financial or payment information, authentication information, personal communications, and location information.
- The daemon forwards that page content to the **AI model provider you have configured** in Qwen Code (for example an OpenAI-, Anthropic-, or Alibaba-hosted endpoint) so the model can act on it. Page content therefore **leaves your machine** as part of ordinary model requests.
- "Stays local" describes the Extension's own communication boundary; it does **not** describe the Qwen Code-to-model-provider path. Only use browser automation with a model provider you trust to receive the browser data needed by the task.

## Data storage

- The Extension stores connection preferences, an optional local daemon authentication token, and a persistent browser-instance identifier in `chrome.storage.local`.
- Tab and session ownership state is stored in `chrome.storage.session` to support cleanup after the background service worker restarts.
- Qwen Code can separately retain browser results in local conversation records, screenshots, downloads, and other output files. AI-provider retention follows the provider's own policy.

## Data sharing

The Extension sends browser data to local Qwen Code processes. Qwen Code may then send it to your configured AI provider to perform your task, as described above.

Qwen Code's use and transfer of data received through the Extension adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including its Limited Use requirements. Browser data is used to provide the Extension's single purpose: connecting Chrome to Qwen Code for user-requested browser assistance. It is not sold, used for advertising, or used to determine creditworthiness or lending eligibility. Transfers are limited to providing that functionality, including processing by the AI provider you configure, and other uses permitted by that policy.

## User control

- Chrome shows the Extension's declared permissions during installation or an update that adds new warning permissions.
- You can disable or uninstall the Extension at any time via `chrome://extensions` to remove Browser Use access.
- Clearing extension storage removes its saved preferences, token, and instance identifier.
- Uninstalling the Extension leaves the separately installed Qwen Code application, Native Messaging host, local conversations and files, and copies already sent to an AI provider to be managed separately.

## Contact

For questions about this policy, open an issue at the [project repository](https://github.com/QwenLM/qwen-code).
