# Managed Agent on the Web Shell home

[English](2026-10-15-managed-agent-home.md) | [简体中文](2026-10-15-managed-agent-home.zh-CN.md)

## Problem and current state

Managed conversations already reuse WelcomeHeader, ChatEditor, MessageList and ToolApproval, as described in [standard Web Shell UI](2026-10-12-managed-web-shell-usability.md). However, App opens them inside a separate management panel with another session list. The normal home and New task still create daemon sessions. Users cannot use the home workflow for Managed work.

## Behavior and scope

Keep Local and Managed modes in the existing shell. A configured Java development entry defaults to Managed; an explicit Local choice and local session links take precedence. Without a Managed provider, preserve the current home. Existing Managed session links remain valid.

Place the mode tabs in the left session sidebar, below New task and above its history. The main conversation has no mode toolbar. Collapsed and narrow layouts expose the same tabs through the existing sidebar surface or drawer.

Managed home uses the standard welcome and composer. Sending creates one bound Session and its initial Turn. The existing shell sidebar shows Managed history instead of daemon projects, and New task opens a Managed draft. Selecting Local restores the ordinary workflow. Switching modes does not cancel work, submit a draft, or copy drafts between backends.

## Component changes and ownership

App owns the chosen backend, home navigation and selected Managed session. ManagedSessionsPage retains its existing list, transcript, stream, admission, draft, approval, cancel, cwd, result and child-task state. A sidebar slot receives its existing session navigation through a React portal, keeping one owner and one Managed list. The exported Managed-only entry retains its current standalone layout.

WebShellSidebar keeps branding, New task, collapse, mobile drawer and theme behavior. A populated session-content slot replaces its daemon catalog surface; hidden daemon catalog requests and New task invalidation are disabled for that slot. Java IDs never enter daemon session methods. Local catalog behavior stays unchanged when the slot is absent.

Use existing UI primitives and shell layout tokens. The conversation retains the shared message/tool/approval components. Compact Managed context controls use the shared composer/context patterns rather than a separate management-page frame.

## Capabilities and persistence

Workspace options come only from Java-authorized discovery. Model choices remain published AgentDefinition presets. Approval policy, arbitrary model selection, attachments, file mentions, slash commands and client-side Shell mode are exposed only when the Managed contract supports them; this change adds none of those backend capabilities.

Keep provider identity/storage scope and all frozen idempotency requests. Preserve drafts and pending confirmations across mode changes. The URL records the selected mode and Managed session independently of settings panels; an explicit local choice survives refresh. Opening a local session switches to Local. A provider identity change discards old in-flight UI ownership as before.

Keep the Managed state owner mounted while hidden, but disable its composers and global keyboard capture. Render its task, result and directory dialogs only while the conversation is visible. The visible Managed composer handles Escape cancellation with the same server authority as its stop button; composition, approvals and dialogs take priority.

## Files affected

- App and Managed URL state: home selection, local/Managed switching, existing deep links and New task routing.
- WebShellSidebar: a session-content slot and catalog ownership gates.
- ManagedSessionsPage: move existing history into that slot and use home layout without its duplicate toolbar/list.
- Shared styles, localized labels, focused tests and Web Shell usage documentation.

## Constraints and risks

Do not change Java APIs, schemas, Runtime provisioning or tool availability. Reuse present components rather than forcing Java data into the daemon-dependent ChatPane. Sidebar collapse/mobile remounts must not reset the Managed conversation or its request owner. An active task continues when its UI is hidden. Browser history and local session navigation must not strand a user in the wrong backend.

## Validation and acceptance

Record the unchanged browser baseline and global CLI version. The global CLI cannot exercise this development-only Java provider entry, so browser baseline and verification use the actual Vite entry with the real local Java stack; identify that boundary explicitly.

Run focused tests for mode/deep-link persistence, sidebar ownership, Managed navigation, drafts, admission, approvals and cancellation; build, typecheck and bundle the repository. Perform two clean self-audit passes and an independent review.

Browser acceptance covers direct home entry, one session list, explicit authorized Workspace selection, create-and-send, real file effects, subsequent turns, one-time Shell approval, cancellation, refresh/history, Local switching without Java IDs reaching daemon endpoints, switching back, and a narrow viewport. Use fresh test sessions and files; preserve the user's existing conversations and leave the experience services running. Controlled tests may exercise failures but do not substitute for the real model/tool loop.

## Open questions

None for this slice. The user selected keeping both modes with the Managed demo defaulting to Managed. Full tool parity and additional Managed APIs remain separate work.
