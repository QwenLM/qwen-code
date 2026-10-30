# User Skill alias recovery guards

[English](user-skill-alias-recovery.md) | [简体中文](user-skill-alias-recovery.zh-CN.md)

Status: candidate correction to PR #15466. New shared-spelling grants remain
blocked on a maintainer decision; this is not full permission-isolation sign-off.

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

Exact registry spellings need the same ownership proof before relaxing a global
restriction. With project `pdf` and extension `rust:pdf`, enabling `pdf` must
preserve a global `pdf` restriction and return its existing block. This also
applies to default grants and hard-to-default conversion. Missing fresh catalog
evidence leaves the standing restriction in place. Complete catalogs with one
owner still allow ordinary exact recovery.
An existing grant can already cancel a shared default restriction. In that
case an enable preserves the fallback restriction and reports no change, after
checking the full identity without assuming that any entries will be removed.
Unresolved hard-to-default conversions cannot establish ownership and retain
the existing hard restriction; pre-registration hard disables remain allowed.

## Boundaries requiring a decision

There is a separate unresolved new-grant path: with no global restriction but a
Workspace `defaultDisabled: ["pdf"]`, a new shared User `enabled: ["pdf"]`
can still affect both project `pdf` and extension `rust:pdf`. The User guard
deliberately excludes Workspace entries, and there is no existing ambiguity
disposition for an otherwise resolved name. Do not fabricate a global block or
treat this remaining isolation issue as accepted behavior.

Recommended decision: add an explicit refusal for new grants whose spelling is
shared or whose ownership cannot be established. Ordinary proven-unique grants
remain available; shared names require settings intervention. The alternative
is a per-identity permission representation, which allows selective shared-name
recovery but requires a separate contract and migration design. Neither is
implicitly accepted by this correction. Catalog checks cover managed workspaces
only and do not establish an atomic inventory across concurrent installations
or unregistered workspaces.

## Validation

Regression tests must refuse single and qualified batch enables that would
remove shared hard/default restrictions, including project/extension,
extension/extension, secondary-workspace and colon-containing collisions.
They must preserve restrictions when fresh enumeration fails, refuse exact-name
recovery without fresh ownership evidence, respect higher-scope locks, preserve unresolved
disables, allow unique-alias recovery and hard-to-default conversion, and reach
the same batch result in both request orders. These are persistence tests with
real temporary settings and controlled catalogs; they do not certify a live ACP
race or another operating system.
