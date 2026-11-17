# Web Shell URL navigation

[English](web-shell-url-navigation.md) | [简体中文](web-shell-url-navigation.zh-CN.md)

## Problem and scope

Proposal for #11073. Standalone session URL updates currently replace history;
Plugins, Channels, Scheduled Tasks, Goals and Settings are only React state.
Refresh and shared URLs therefore lose the selected page. The library needs the
same routing implementation with optional URL ownership and a configurable base.

## Protocol and ownership

The base path contains sibling routes `/session/<encoded-id>`, `/plugins`,
`/channels`, `/scheduled-tasks`, `/goals`, and `/settings`. The base itself is an
empty chat, not a request to allocate a session. Session URLs retain the existing
`workspace=<id>` and `context=standalone|live` semantics; non-workspace context
wins over workspace. Page URLs have no session scope. Settings records only the
page, not a settings scope, category, model, or suggestion.

Embedded URL ownership is opt-in. The default preserves externally supplied
session/workspace props and existing behavior. With URL ownership enabled, URLs
supply the initial target unless explicit external session target props are
present. Later external target changes take precedence and replace the URL;
hosts must stop their own history writes. The locked workspace remains a host
constraint. Standalone enables the same owner and infers its existing deployment base (root by default). Hosts set basePath to
`/agentic-code`; parameters such as instanceId and instanceType remain opaque and
are preserved, along with unrelated query parameters and fragments.

## Host integration

URL ownership covers the shell's own page navigation and browser history. It
currently exposes no controlled `page` prop, `onPageChange` callback, or public
page navigation hook. Session target props and `onSessionIdChange` remain
supported; pages are not controlled through an equivalent host API. A host can
open a page with a normal deep link (document navigation), but synchronizing
host-owned breadcrumbs or navigation without a reload is outside this change.
Do not use manual history writes or synthetic popstate events as a substitute
for a supported page API. A page control/notification API can be designed in a
separate change when an embedding host requires it.

## State and history

A shared navigation boundary above WorkspaceSessionProvider owns route replay
and session targets. App integrates page transitions at existing action points.
Page navigation retains the attached background session. A namespaced
history.state entry holds the return target; existing host state is preserved.
Direct page links without a return target go back to empty chat without creating
a session. A copied page URL therefore does not inherit private return state.

User navigation pushes history, repeated current-page clicks do nothing,
initial normalization and external reconciliation replace history, and popstate
replays without writing. Pending route restoration is protected from initial
empty-session callbacks. Page availability is checked after capabilities load;
unavailable pages fall back to chat. Existing session resolution, missing-session,
workspace and standalone gates stay authoritative. Navigation during asynchronous
loading must not allow an older completion to overwrite a newer target. A failed
sidebar session load retains the requested target and its error state, so its URL
also remains on that target for retry; it does not restore the previous session.

## Compatibility and deployment

Cockpit, connections settings, and split links keep their existing purposes;
this change adds no routes for split, details, filters, archives, workspace
overviews, or artifacts. Explicit page paths take precedence over old view hints.
Existing history writers must preserve the navigation state namespace.

Vite and the production daemon must serve page HTML for document GET/HEAD
requests on the five exact paths, including cold token-protected startup.
JSON requests, API subpaths and writes retain authentication and API behavior.
These are process-global public document routes, with no session or workspace
data in their response. The host must serve its SPA entry for base and deep
paths and preserve API routing; basePath does not configure server rewrites.

## Validation and follow-up

Collocated protocol and React integration tests cover encoding, boundaries,
unknown queries, external props, initialization, missing targets, history and
no-URL mode. Browser interaction tests cover all five pages, root and embedded
bases, session context, refresh/new tabs, back/forward and no extra allocation.
Daemon tests cover cold/warm document navigation and authenticated API behavior.
Run the upstream build, typecheck, focused tests, full preflight, real browser
smoke and two clean self-audit passes before a focused upstream PR.

Console integration is a separate change: upgrade to the reviewed upstream
revision, enable URL ownership with the base path, remove duplicate history
writes, preserve host authorization/connection setup and settings allowlists,
and retain hidden split controls. No Console files or submodule pins change here.

The browser smoke test captures Settings after reloading its page URL:

![Settings restored after reload](images/web-shell-url-navigation.png)

## Review regression coverage

The review follow-up preserves host and navigation history state across remote
workspace cleanup and failed daemon switching. Its focused unit suite passed
49 tests; five real createServeApp route cases passed, checking public document
GET/HEAD against protected API requests and API-only response parity. The URL
navigation and remote-workspace browser suites passed all 17 tests, including
a failed sidebar session load followed by a successful retry of that same target.
These focused results do not replace or claim a green full-repository preflight.
