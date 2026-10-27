# Managed Workspace Web Fetch

[English](2026-10-23-managed-web-fetch.md) | [简体中文](2026-10-23-managed-web-fetch.zh-CN.md)

## Problem and scope

The `web_fetch` part of [#15076](https://github.com/QwenLM/qwen-code/issues/15076) is missing from the main Hosted Workspace profiles. Add it to the existing files, shell, search and team lead profiles. Snapshot read profiles and the separate CSI files contract retain their existing tool vocabulary. `todo_write`, authenticated fetching and binary downloads are outside this change.

## Execution and permissions

Declare `url`, `prompt` and optional `format` with the shared tool's existing semantics. Validate arguments before acquiring a Runtime and normalize GitHub blob URLs before approval so the approval preview identifies the actual destination. Keep `default` and `auto-edit` approval; `yolo` retains the deployment's explicit approval bypass. Fetching remains unavailable in plan mode because an outbound request can disclose information.

Execute through the existing Session-owned Broker Tool v2 path, using the bound Runtime's `WebFetchTool` in an explicit managed mode. The worker returns normalized text and metadata to the conversation model instead of making a side query without model credentials. Managed mode refuses binary content, never spills content to host files, and bounds its text preview to 16 KiB after JSON encoding with a truncation notice. The existing durable size guard remains authoritative for the final encoded envelope.

## Network policy

Managed fetching accepts only credential-free HTTPS URLs resolving entirely to public addresses. Reuse the extension network policy's address classification and pinned lookup for every request, redirect hop and retry. Move that shared implementation to Core utilities while preserving the extension import path through a re-export. A dedicated Undici agent and its matching bundled fetch pin the approved DNS result, require TLS certificate verification and bypass the process-wide proxy dispatcher. Refuse non-Node runtimes because their native fetch may silently ignore the dispatcher. Private, loopback, link-local, metadata and reserved addresses are refused, including IPv4-mapped IPv6 and mixed public/private DNS answers. Managed mode never downgrades to HTTP. Cross-host, scheme or port redirects are returned to the model for a new call and approval; they are never followed automatically. Network policy and response limits also apply under `yolo`.

## Durability and compatibility

Advertise `web-fetch/1` in the Harness capability envelope. Add the native tool to approval input previews on both sides, approval continuation validation, native batch recovery, and lifecycle recognition of inline results. Keep the shared file-only declaration baseline at Read/Write/Edit for CSI and its saved recovery definitions; compose web fetch only into the main profiles. Reuse ordinary tool result persistence and cancellation; no database, public API or new route is needed. Upgrade Runtime workers with the Harness before offering the capability. Existing local `web_fetch` keeps its side query, private-network access, proxy behavior and download support.

## Affected areas

- Core web fetch and bounded HTTP transfer, with focused network and managed-mode tests.
- Hosted declarations, argument validation, capabilities, approval continuation and Runtime tool registration.
- Java approval previews and inline-result lifecycle validation, with affected tests.
- Managed Agent documentation and the local E2E plan.

## Validation and acceptance

Use `.qwen/e2e-tests/managed-web-fetch.md` for baseline and post-change checks. Verify public HTML/markdown/text, format negotiation, redirects, HTTP errors, response limits, cancellation, binary refusal, and bounded output without host paths. Test private and mixed DNS rejection, pinned connections across redirects/retries, TLS verification, and approval deny/resume. Verify normal inline result recovery and lifecycle settlement. Run affected Core/CLI tests, root build/typecheck/bundle, Java affected tests and `mvn verify`; report unavailable real-model or deployment checks separately.

Acceptance requires the main profiles to declare and execute `web_fetch`, approval to show the actual URL, denied calls to make no request, safe public text to reach the model and durable history, and settled calls to permit lifecycle cleanup. Deployment acceptance remains separate from local verification. There are no unresolved design questions.
