# Web Shell AskUserQuestion Submit Retry

## Problem

`AskUserQuestion` locks immediately after a decision is clicked, but its
callback does not expose the asynchronous permission result. A failed request
therefore leaves an apparently enabled panel that silently ignores retries.
The submit path also silently returns when the permission payload has no
`allow_once` option.

## Design

- Give `AskUserQuestion` a promise-returning confirmation callback and an error
  reporter supplied by its owning chat surface.
- While the request is in flight, disable the actions and show a submitting
  indicator.
- Keep a successfully accepted decision locked while the permission event
  removes the panel. This also covers consensus votes that were recorded but
  are not final yet.
- On rejection or a `false` result, report the error and unlock the actions so
  the user can retry.
- Report a missing `allow_once` option immediately instead of returning
  silently.
