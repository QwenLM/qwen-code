# Cycle 58 — Push-preferences config web UI (`/rc/push/subscriptions` editor)

Proposal: `add-webpush`. The backend for per-subscription delivery
preferences is fully built — `GET /rc/push/subscriptions` (own; `?all=true`
for OWNER) and `PATCH /rc/push/subscriptions/:id` (validates `prefs`,
`quietHours`, `maxPerHour`). The missing piece is the **client surface**:
a browser section to view subscriptions and edit their quiet-hours window
and per-hour rate cap.

## Deviation note

As with every gateway cycle the OpenSpec `design.md` is daemon-centric;
this delivers the capability gateway-side as a self-contained section in
`packages/rc-gateway/public/index.html` consuming the existing OWNER
routes. No daemon change.

## What it adds

A self-contained "Push preferences" section: a "List subscriptions" button
that fetches `GET /rc/push/subscriptions?all=true` (OWNER) and renders one
row per subscription with editable `quietHours` (`from`/`to`/`timezone`)
and `maxPerHour` inputs plus a per-row Save that `PATCH`es that
subscription. Read-only display of the current `prefs` kind-allowlist.

## Decisions (advisor-steered)

1. **Owner-all framing (`?all=true`).** The `/ui` is an owner console; an
   OWNER token's _own_ push subscriptions are almost always empty (you push
   to the phone, not to the laptop that minted the OWNER token). So an
   own-listing screen would be empty in real use. `?all=true` is both the
   realistic framing AND the one a seeded-sub harness can verify — they
   coincide. Chosen deliberately, not for harness convenience.
2. **Never render the raw `endpoint`.** `?all=true` returns it; it is a
   sensitive push capability URL. Rows identify a subscription by `id` +
   `createdAt` + the editable fields only.
3. **Defer the `prefs` kind-allowlist EDITOR; ship quietHours + maxPerHour.**
   The route author flagged the footgun: `prefs:[]` = "receive nothing",
   `prefs:null` = "receive all" — opposite meanings a checkbox UI that
   deselects everything would conflate into a silent global mute. A safe
   prefs editor needs an explicit "all vs custom" toggle; that is a future
   thin slice. This cycle shows `prefs` READ-ONLY and edits only the two
   unambiguous numeric/time fields.
4. **Surface the backend 400 codes** (`invalid_quiet_hours`,
   `invalid_max_per_hour`) in the row — a silent failure on a
   notification-delivery config is exactly the bug class to avoid. A
   partially-filled quiet-hours window (e.g. `from` set, `timezone` blank)
   is sent as-is so the backend's `parseTimeOfDay` rejects it and the UI
   shows the code, rather than the UI silently dropping the field.
5. **Save semantics.** quietHours: all three inputs blank -> send `null`
   (clear); otherwise send `{from,to,timezone}` verbatim (backend
   validates). maxPerHour: blank -> `null` (clear); otherwise `Number(...)`.
   Both keys are always sent (the form reflects full current state); `prefs`
   is never sent, so editing here can't disturb a configured allowlist.
6. Self-contained section (new ids `list-subs`/`subs`), touches no existing
   handler; createElement + `textContent`/`input.value` only (XSS-safe —
   all rendered fields are server hex/enum/number; the endpoint is never
   rendered).

## Feasibility / harness

Push routes mount only when `createGatewayApp` gets BOTH `vapid`
(`VapidStore`) and `pushStore` (`PushStore`) — both barrel-exported with
`static async open(filePath)`. The `/tmp` harness (not committed) is
enhanced: open a `VapidStore` + `PushStore`, `pushStore.add(tokenId, {...})`
one fake subscription (fake endpoint/keys), optionally seed a quietHours via
`setQuietHours`, pass both into `createGatewayApp`. The OWNER-paired browser
then lists `?all=true`, edits quietHours/maxPerHour, Saves, and re-lists to
confirm the PATCH round-tripped. No product code depends on the harness.

## Verification

Playwright in-session against the enhanced harness: pair OWNER -> List
subscriptions -> assert the seeded sub renders (id, NOT endpoint) -> set
maxPerHour + a valid quietHours -> Save -> assert 200/saved -> re-list and
assert the values persisted; then set an invalid timezone -> Save -> assert
the `invalid_quiet_hours` code surfaces. lint/build/test unchanged (no `src`
change; `public/` is served raw), e2e 45/45.

## Deferred

The `prefs` kind-allowlist editor (needs an explicit all-vs-custom toggle to
avoid the `[]`-vs-`null` silent-mute footgun); a timezone picker/validation
hint; an own-subscriptions (non-owner) view; unsubscribe-from-this-UI
(DELETE already exists, token-mgmt-style) — later thin slices.
