# Cycle 60 — Push prefs kind-allowlist editor (all-vs-custom toggle)

Proposal: `add-webpush`. Cycle 58 shipped quietHours+maxPerHour editing but
deferred the `prefs` kind-allowlist EDITOR because of the silent-mute footgun:
`prefs:[]` = "receive nothing" vs `prefs:null` = "receive all" are opposite
meanings a naive checkbox-deselect-all would conflate. This cycle ships the
editor with the advisor-prescribed fix: an explicit all-vs-custom toggle.

## Deviation note

Gateway-side UI; consumes the existing `PATCH /rc/push/subscriptions/:id`
`prefs` field (validated `string[]|null`, cycle 16/29). No daemon change.

## The footgun and the fix

The backend already distinguishes the two meanings (`'prefs' in body`,
`prefs:null` clears -> receive all, `prefs:[]` mutes). The UI must NOT let a
user accidentally pick "mute everything" while thinking they reset. So:

- A per-row mode `<select>`: **"Receive all"** -> sends `prefs:null`;
  **"Custom"** -> sends `prefs:[checked kinds]`.
- "Custom" reveals checkboxes for the known kinds. Choosing Custom and
  checking NOTHING sends `prefs:[]` (mute all) — but now it is an EXPLICIT,
  deliberate choice (the user picked Custom, unchecked everything), not a
  silent side effect of deselecting. That is exactly the distinction the
  advisor required.

## Known kinds

The notifier's `KIND_SCOPES` (notifier.ts:26-27) defines the push kinds:
`permission.required`, `task.completed`. The editor hardcodes this list (a UI
constant with a comment pointing at KIND_SCOPES). If a future kind is added
the editor won't show it until updated — a documented limitation; the
backend still accepts any string array.

## Decisions

1. Replace cycle-58's read-only `prefs:` text in the row head with the mode
   `<select>` + a checkbox container (shown only in Custom mode; toggled on
   `select.onchange`). Initialize from `s.prefs`: undefined -> "Receive all",
   checkboxes hidden+unchecked; an array -> "Custom", shown, each known kind
   checked iff present (an array containing an unknown/legacy kind still
   round-trips because Save rebuilds from the checkboxes — KNOWN tradeoff,
   noted Deferred: a custom array with an unknown kind would DROP that kind on
   the next Save; acceptable since the only kinds the backend emits are the
   two known ones).
2. Extend `saveSub` to also send `prefs`: mode 'all' -> `null`; mode 'custom'
   -> the checked kinds array. `prefs`/`quietHours`/`maxPerHour` all sent
   together (the form reflects full state); the backend applies each present
   key independently.
3. textContent / DOM-property only (kinds are a fixed UI constant, not server
   data; no innerHTML). Additive to `subRow`/`saveSub`; no other handler
   touched. No src change.

## Verification

Playwright in-session (cycle-58 harness): List -> the seeded sub (no prefs)
shows mode "Receive all". Switch to Custom -> checkboxes appear; check only
`task.completed` -> Save -> re-List shows mode Custom with only that box
checked (PATCH round-tripped `prefs:['task.completed']`). Switch back to
"Receive all" -> Save -> re-List shows mode "Receive all" (`prefs` cleared).
Custom + uncheck all -> Save -> re-List Custom, none checked (`prefs:[]`
persisted, the explicit mute). lint/build/test unchanged, e2e 45/45.

## Deferred

Dynamic kind discovery from the backend; a "mute all" confirmation;
preserving unknown/legacy kinds in a custom array across a Save.
