# Extension Skill Owner Identity

## Problem

`GET /workspace/skills` exposes the owner of an extension-level Skill through
`extensionName`. Extension discovery currently stores the localized Extension
display name in that field. Display names can change with locale and are not
unique, so clients cannot use the response to join a Skill to its Extension.

## Contract

- `extensionName` is the canonical `name` from the loaded Extension manifest.
- `extensionDisplayName` is the optional, locale-resolved display name.
- Identity matching, inactive-state checks, and snapshot deduplication use only
  `extensionName`.
- Presentation uses `extensionDisplayName ?? extensionName`.

Both fields remain optional because non-Extension Skills do not have an owner
and older daemons do not expose `extensionDisplayName`. The status schema stays
at version 1 because the new field is additive.

## Data flow

The Skill manager records both values when it enumerates active Extensions.
The ACP workspace snapshot applies the same rule when it synthesizes Skills
from inactive Extensions. The shared workspace-skills mapper then projects the
two values into the ACP Bridge and TypeScript SDK status types.

CLI and Web Shell presentation read the display field with a canonical-name
fallback. MCP and Agent ownership metadata are separate contracts and are not
changed here.

## Compatibility

Existing third-party clients continue to receive `extensionName`, but its value
is corrected from display text to the manifest identity. Clients that need a
friendly label can adopt `extensionDisplayName`; new clients remain compatible
with older daemons by falling back to `extensionName`.
