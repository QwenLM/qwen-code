# Cycle 67 — Slash-commands palette web UI (`GET /rc/commands` + invoke)

Proposal: `add-custom-slash-commands`. The backend is built (loader, `GET
/rc/commands` with `invocableByYou`, `POST /rc/session/:id/command/:name`
invoke). This adds the client palette.

## Deviation note

Gateway UI; consumes the existing routes. No daemon change.

## Route contract (read from source)

`GET /rc/commands` (SESSION_READ) → `{v:1, commands:[{name, description, scope,
tool, sessionScope, args, source, invocableByYou}]}` (commands above the
caller's scope are LISTED with `invocableByYou:false` so a palette grays them
out). `POST /rc/session/:id/command/:name` (WRITE) invokes against a session.

## What it adds

A "Commands" `<section>`: a "List commands" button → `GET /rc/commands` → one
row per command: `name  —  description  [scope]  (source)`, with an Invoke
button that targets the current `#session` value (`POST /rc/session/<id>/
command/<name>`). A command with `invocableByYou:false` is grayed out and its
Invoke disabled (the palette shows it but can't run it — matches the backend's
list-don't-hide design).

## Decisions

1. Invoke uses the existing `#session` input value as the target (same pattern
   as the search "Open"/watch panel); if empty, prompt the user to watch/enter a
   session first. Invoke surfaces the result `stopReason` / error code.
2. `invocableByYou` drives both a grayed style and `button.disabled` — the
   server still gates (WRITE ∧ scope ∧ no-tool), this is only UX.
3. textContent/createElement only (name/description/scope are operator-authored
   command-file fields → textContent, never innerHTML). Additive section (new
   ids `list-commands`/`commands-list`), no existing handler touched. No src
   change.

## Feasibility / harness

`GET /rc/commands` is loader-backed (no daemon). The harness is enhanced (still
/tmp): a temp `commandsUserDir` with one seeded `.md` command
(`---\nname: triage\ndescription: ...\nscope: write\n---\nbody`) passed to
`createGatewayApp`, so the list renders a real row. (Invoke hits the daemon's
command route → the stub daemon doesn't run it → the wiring is verified, not a
live invocation; noted.)

## Verification

Playwright in-session: pair OWNER (has WRITE) → List commands → the seeded
`triage` row renders with description/scope and an enabled Invoke (OWNER has
WRITE+write-scope, no tool → invocableByYou:true). lint/build/test unchanged
(no src change), e2e 45/45.

## Deferred

A fuzzy-search palette / Cmd-K; argument prompts before invoke; the
`X-Commands-Revision` ETag caching in the client; live-invoke verification
(needs a real daemon).
