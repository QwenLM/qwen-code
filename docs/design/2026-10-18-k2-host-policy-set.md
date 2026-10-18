# K2 complete host policy artifact set

[English](2026-10-18-k2-host-policy-set.md) | [简体中文](2026-10-18-k2-host-policy-set.zh-CN.md)

## Status and problem

Proposed software increment. The profile target names the runtime, kubelet,
registrar, CSI backend, PID 1 and system bus labels, but the renderer and
compiler currently produce only five Qwen profiles. The source checks those
five loaded profiles against the original packed artifact. Neither the peer
labels nor a few reciprocal permissions supply the complete host policies.

## Artifact contract

Add a mandatory, separately reviewed `host-policies.json` with format
`qwen-k2-host-policies/1`. Its only other field is `files`, containing byte
counts and SHA-256 pins for exactly `host-runtime.rules`, `host-kubelet.rules`,
`host-registrar.rules`, `host-plugin.rules`, `host-systemd.rules` and
`host-system-bus.rules`. These fixed files contain the complete expanded base
rule bodies for their roles, not just the K2 additions. Each body is nonempty
UTF-8, at most 1 MiB. The manifest is at most 64 KiB. An independently reviewed
manifest digest is required at rendering; no caller file names enter the graph.

The generator owns each profile header, attachment and enforcement flags. The
five executable attachments use the corresponding protected target paths; a
distinct system bus profile has no attachment and needs explicit installation
entry. Its name must not start with `/`, because AppArmor would otherwise infer
an executable attachment. Headers use `flags=(enforce,mediate_deleted)`. The system bus may retain
an existing host label only when both roles' complete base rule bytes are
identical. Compose that profile once and combine both roles' fixed additions.
The five executable host labels remain distinct. This does not establish that
PID 1, the bus or every thread actually entered the label.
All host labels are literal names in the root namespace, without `:` or `//`,
without a trailing slash and starting with an alphanumeric character or `/`.
A slash-leading bus name is accepted only as an alias of an explicitly attached
host profile with identical complete base bytes.

The first supported input lane is deliberately flat: one comma-terminated rule
per line with two-space indentation, no preamble, comments, continuations,
variables, includes, aliases, ABI, nested profiles, hats or conditional blocks.
Quote paths and other AARE values that contain braces. A quote/escape-aware
scan distinguishes those values from structural braces; do not insert text
before a guessed final brace. Base rules preserve their exact bytes, including
denials. Parenthesis depth and the unique final top-level comma prevent a
second rule on the same line. File rules use a quoted path followed by permissions,
optionally with `file` and ordinary qualifiers; other spellings refuse. This
lane follows the [AppArmor grammar](https://www.apparmor.net/man/4.0/apparmor.d/)
while accepting only this subset. Unknown rule kinds, self-directed profile changes and file execution
other than inheritance refuse. Required transitions from the runtime to the
fixed shim and from PID 1 to the fixed services are owned by the generator.
The actual pinned parser remains responsible for AppArmor grammar and feature
compatibility. Input validation is not a semantic confinement review.

## Composition and consumers

Keep the five Qwen profiles code-owned. Append the complete host profiles and
fixed reciprocal ptrace, Unix, signal and D-Bus rules for the existing peer
operations. Source/gateway must be able to read all seven new artifact leaves.
No generic allow-all base, discovered policy directory or automatic denial
removal is provided. A base denial conflicting with an addition remains a
denial and must fail the native acceptance instead of being silently removed.

Pathname Unix sockets use literal file access rules. Unix `peer=(label=...)`
rules cover abstract/anonymous sockets; they do not enforce pathname peer
labels. The actual programs retain their SO_PEERCRED, executable, process,
namespace and held-peer checks. Actor/admission exclusion and native
qualification remain required; no pathname LSM peer guarantee is inferred.

Advance the candidate to `qwen-k2-profile-candidate/2` and installation to
`qwen-k2-installed-artifacts/2`; old candidates refuse without conversion.
Both file graphs contain the manifest and all six complete bases. Compilation
checks the exact generated host suffix from its pinned inputs before invoking
the existing no-load parser command. The compilation/2 and target/2 fields do
not change. The complete source stays within 16 MiB, packed output within 8 MiB
and installation graph within 64 MiB.

The Go artifact validator and Java independent-metadata reader enforce the
same fixed files, bounds and nested pins. Derive the complete unique host label
set from the validated target. The source retains each additional original
profile object and rechecks its enforce mode, directory/object identity and
link to the same original packed `raw_data` at existing policy boundaries.
This set also covers the three other Qwen birth actors. Keep the existing
source and worker observations; no new authority field, source/7 version or SQL
schema change is needed for this byte association.

## Files and validation

Changes affect the profile renderer/compiler and their tests, the Go artifact
validator/assembler and loaded-policy guard, the Java reviewed-byte reader and
affected tests, plus the linked pre-exec design in both languages. Validate
complete composition and bus-label reuse, missing/changed/extra bases, quoted
and escaped AARE values, structural breakout, ambient dependencies, forbidden
transitions, stale versions, nested pin changes and shared byte budgets.
Keep inert parser/packed fixtures explicitly separate from native evidence.

A no-load/no-cache stdin syntax smoke using the existing AppArmor 5 parser is
separate from compilation with the reviewed target Ubuntu 24 parser/features.
It produces no positive compilation or installation protocol record and does
not qualify native confinement.

Run the global CLI baseline with a direct-script fallback for this private
offline stage, Python tests, Go tests and Linux amd64/arm64 compilation, root
build/typecheck, affected Java tests and unfiltered Maven verify. Preserve failed
attempts, audit the complete diff twice and obtain independent review.

## Acceptance and remaining work

Software acceptance requires one complete pinned source/installation graph,
matching fixed-role consumers and refusal without partial output when an input
is unsupported. It does not qualify the actual installation. Independently
reviewed runnable base policies, real pinned parser compilation/export,
kernel-loaded labels and all-thread entry, normal Create/Start/Delete,
node-wide policy lock, actor/admission exclusion and cold exclusive CSI remain
native acceptance requirements. D-Bus message bodies remain outside AppArmor's
comparison boundary. Final physical authority, atomic four-row release,
RELEASED historical reads and safe later-cycle reuse remain unfinished and
fenced. No cloud mutation or policy loading is part of this software increment.

There is no open software format question in this lane. Native base policy
content and actual PID-1 entry must be reviewed against the fresh owned node;
they cannot be inferred from executable paths, labels or historical ACK data.
