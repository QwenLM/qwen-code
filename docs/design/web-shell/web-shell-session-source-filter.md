# Web Shell session source filtering

## Problem

Web Shell sessions are currently created without source metadata, and every
session-list request is unfiltered. This lets sessions created by other
features, such as scheduled tasks, appear in Web Shell. Existing Web Shell
sessions also have no source metadata, so an exact source filter would hide
historical data.

## Design

- Create every new Web Shell session with `sourceType: 'default'`.
- Add `sourceType: 'default'` to filtered Web Shell session-list requests. The
  Sidebar remains unfiltered because it is the all-session catalog.
- Treat `sourceType=default` as a compatibility filter that matches both
  `sourceType: 'default'` and sessions without `sourceType`. Other source
  filters remain exact matches.
- Support the source filter with organized session views so filtering does not
  disable grouping, pinning, or archived-session behavior.
- Bind organized pagination cursors to the source filter that produced them.

## Compatibility

Older sessions remain visible in Web Shell because missing source metadata is
included only for the `default` filter. Sessions attributed to another source
remain excluded. Callers that omit `sourceType` retain the current unfiltered
behavior.
