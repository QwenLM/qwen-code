# Session-backed Skills menus

[English](session-backed-skills.md) | [简体中文](session-backed-skills.zh-CN.md)

## Problem and scope

Some hosts expose Skills only after a session exists. On a fresh composer, reading a workspace catalog cannot provide that session's authoritative commands. Preparing a session for the menu must also preserve the draft and reuse the same session when the user sends their first prompt.

This change adds an opt-in WebShell integration. It does not change server authorization, install resources, submit a prompt, or add a second session-creation lifecycle.

## Design

The optional `skillsRequireSession` prop defaults to `false`. When enabled, opening the built-in Skills menu or help dialog prepares the current composer's session and reads its supported commands. A custom footer does not eagerly prepare a session merely by mounting; hosts can call the optional composer API `ensureSession()` when their menu opens.

Session preparation reuses the existing prompt preparation promise. A concurrent prompt can share that preparation and retain its detached client for admission. Menu-only preparation detaches its client if navigation has displaced the composer. Mount, source-version, current-session, request-generation, and response-session checks prevent obsolete work from populating another composer's menu.

The composer uses its existing draft-assignment mechanism to migrate current text and attachments when the session is allocated. Assignment is restricted to the same composer history and draft storage identity. A concurrent Send can take ownership of that assignment.

## Compatibility and risks

Existing hosts retain their default catalog behavior. Hosts that opt in need a session supported-commands endpoint and must tolerate session creation latency when opening the first menu. Opening a menu can allocate a session without creating a turn. This client change cannot make a backend initialize resources that its session lifecycle does not expose.

The main risks are stale asynchronous results during navigation and draft migration while preparation overlaps Send. Existing ownership checks remain in place; no fallback borrows an unrelated session.

## Acceptance and validation

1. On a fresh composer with session-backed Skills enabled, open the menu and see commands belonging to the allocated session, without submitting a prompt.
2. Select a Skill and send; reuse the prepared session and preserve the current draft and attachments during preparation.
3. Navigate while preparation is pending; the old result must not populate the new composer. Concurrent Send must retain its existing admission behavior.
4. With the option omitted, preserve the existing workspace-catalog path and custom-footer behavior.

The first-menu preparation, menu display, and draft retention were confirmed in an integration environment before this main-based extraction. Tests, builds, lint, and type checks have not been run on this new base. Navigation races and the default path remain reviewer verification items. This draft covers session-required catalogs only. First initialization can still delay the menu while session preparation completes. Preparing a catalog before session creation and making worker readiness imply catalog readiness are outside this change; no first-open performance improvement is claimed.
