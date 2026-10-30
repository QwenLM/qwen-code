# User Skill alias recovery guards

[English](user-skill-alias-recovery.md) | [简体中文](user-skill-alias-recovery.zh-CN.md)

Status: candidate correction to PR #15466. The full shared-spelling recovery
contract still requires maintainer acceptance.

## Problem and scope

A User `skills.disabled: ["pdf"]` entry can restrict both `rust:pdf` and
`go:pdf`. Removing it while enabling only `rust:pdf` silently releases the
other restriction. Conversely, converting a unique legacy hard alias to
`default` mode must remove that hard alias or the requested mode never takes
effect. Restriction lookup must keep both registry and authored spellings.

## Candidate behavior

Before taking the settings write lock, enumerate the primary and other managed
workspace catalogs. Only a resolved identity with complete, trusted, freshly
enumerated catalogs can remove an authored alias. Retained snapshots, even with
`stale: false`, and error-bearing catalogs cannot prove unique ownership.

Index both registry and authored spellings by registry identity. This includes
colon-containing names: `go:pdf` may be both the registry name of one Skill and
the authored spelling of `rust:go:pdf`. Repeated observations of the same
registry identity in different workspaces do not create ambiguity.

Remove a proven unique alias from the User hard/default disable lists on both
enable and disable-mode conversion. Keep shared or unresolved aliases intact.
Use the full identity when finding blocks, but exempt only entries the write
actually removes. System/SystemDefaults hard locks remain authoritative.
Batch enables recheck entries removed or cancelled by earlier explicit items.

## Boundaries requiring a decision

This correction narrows the existing alias purge; it does not introduce a new
permission override. Explicit writes to an exact registry spelling still use
the existing shared-spelling settings semantics and may affect other matching
Skills. Catalog checks cover managed workspaces only, and do not establish an
atomic inventory across concurrent installations or unregistered workspaces.

Maintainers must decide whether these boundaries are acceptable. A stricter
alternative is to preserve every alternate spelling and design an explicit
recovery operation or per-identity permission model. That alternative is not
implicitly accepted or implemented by this correction.

## Validation

Regression tests must refuse single and qualified batch enables that would
remove shared hard/default restrictions, including project/extension,
extension/extension, secondary-workspace and colon-containing collisions.
They must preserve restrictions when fresh enumeration fails, retain exact-name
recovery from cached identities, respect higher-scope locks, preserve unresolved
disables, allow unique-alias recovery and hard-to-default conversion, and reach
the same batch result in both request orders. These are persistence tests with
real temporary settings and controlled catalogs; they do not certify a live ACP
race or another operating system.
