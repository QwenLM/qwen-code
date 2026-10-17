# K2 installed-byte journal association

[English](2026-10-17-k2-installed-byte-journal.md) | [简体中文](2026-10-17-k2-installed-byte-journal.zh-CN.md)

## Status and problem

Implementation candidate over c4c065dca; ordinary data verification is in progress. The actual source and gateway now compare their retained installation bytes through runtime identity/2. Source/6 still omits those observations from durable SOURCE_START, and ARM does not preserve the original held kubelet/registrar peers. Java cannot compare the recorded installation with independently reviewed metadata. This increment closes that data path; it does not certify an installation or authorize release.

## Producers and format

Use a new closed `qwen-k2-node-source/7` format. Append the actual source and gateway `qwen-k2-installed-byte-observation/1` values to source identity in SOURCE_START. Values come from the existing retained-object loader and authenticated original gateway identity, with full original manifest hash and exact role inputs. No caller flag or copied expectation becomes an actual observation.

After the existing ARM readiness verification, take both immutable peer identities from the already held frontend peers, under their existing lock and process verification. Save exactly kubelet and registrar in ARM. Require the saved publication caller to equal that ARM kubelet identity; later unpublish retains the original publication caller check. Same-ARM retries return the original record. Missing, changed or lost peers refuse; no replacement PID lookup is added.

Keep Go field order and canonical body hashing explicit. Only SOURCE_START carries installation observations, and only ARM carries the frontend pair. Preserve length framing, sequence/hash chain, dependency cursors, exact raw-prefix extension and all existing birth/policy/stop checks. Source/6 and older records are refused by the new decoder, without byte, hash or saved-history conversion. Keep the old fixture immutable as a negative control.

## Independent expected values and Java consumers

The reviewed node deployment input adds the mandatory `installedArtifacts` metadata directory; Node persists mandatory `installedBytes` expectations. Read only fixed bounded metadata names, not configuration-referenced TLS/key paths. Verify each consumed original raw file against installation.json and derive the two role observations from the reviewed manifest, profile candidate, compilation record, exact source/shim configuration and unit metadata. The operator's separately reviewed bytes provide expectations; observed stream fields must never populate them.

Persist mandatory source/gateway byte expectations and reviewed kubelet/registrar digests in Node configuration. The existing common validator compares both SOURCE_START observations, packed length/hash and ARM frontend digests during ARM/BIND/publication persistence and restored reads. Publication caller association is checked by the journal state machine. Existing physical-source validation naturally reuses this common path; add no separate authority or success DTO.

The existing 64 KiB configuration, 1 MiB evidence and 192 KiB record budgets remain. Persist compact hashes, paths and peer identities, not packed policy/catalogue/TLS content. Old Node JSON lacking required expectations refuses rather than acquiring defaults. No SQL migration or positive release state is added.

## Verification and acceptance

Use only ordinary portable bytes/MapFS tests, explicitly selected pure Java JSON tests and ordinary H2 data tests whose fixtures do not start native processes or network services. Preserve synthetic fixture provenance. Verify exact Go/Java field order, current-format positive controls, old-version rejection, missing/unknown/changed fields and roles, original peer association, independent expectation mismatch and whole-row/prefix preservation. Compile Linux source/shim/assembler outputs without executing them. Existing restricted native/source/custody/observer/Hosted/Main-F2/MySQL/process-fault and parser/image/ELF groups are not rerouted or run.

Acceptance of this increment means every new field has a real production producer and consumer, independent reviewed expectations and closed current-version decoding; actual native behavior remains unverified. Update both languages and deployment inputs together and complete focused checks and two clean diff audits.

## Remaining work

Effective systemd/runtime configuration, host actor/namespace and CSI-exclusive installation facts and their qualification remain incomplete. A journal hash is not an external trust root. Final four-row atomic release, historical released credentials and safe later-cycle volume reuse remain disabled pending the complete installation and lifecycle authority. No public selection or release capability follows from this increment.
