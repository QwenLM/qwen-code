# Private CSI file profile: local-process boundary

[English](2026-10-11-csi-local-process-boundary.md) | [简体中文](2026-10-11-csi-local-process-boundary.zh-CN.md)

## Problem and scope

PR #13526 proposes the private `csi-files-retirement/1` capability for a dedicated
Kubernetes worker. Main has no production caller that selects this capability.
This extraction introduces its identity and local refusal before that future
admission path, rather than fixing an existing production CSI path on main.
The local-process provisioner must not resolve storage,
launch or adopt a child, modify its durable registration, observe operator
termination, or release a process for this capability. Checking the provisioner
kind alone is insufficient: callers can submit the reserved digest with a
local-process request or a different isolation class.

This is an independent extraction from PR #13526. It preserves that unmerged
proposal's profile identity and closes the Java local-process entry points. Kubernetes
execution, Node worker admission, SQL Session pins, recovery, CSI unpublish,
and volume reuse remain separate work.

## Decision and contract

Keep PR #13526's capability manifest and SHA-256 digest unchanged. The profile
request retains canonical Session UUID isolation, Workspace generation and
storage identity, the root-relative working directory, and a canonical absolute
mount root. Its existing request encoding remains compatible with the Broker.

The local provisioner checks the capability before storage resolution, both
provision overloads, resource creation/adoption, reconciliation, confirmation,
operator registration/stop observation, and release. A match returns a
non-retryable HTTP 409 `runtime_provision_failed`, for both `session` and
`workspace` isolation. Asynchronous operations return failed completion stages.
Ordinary capabilities continue through their existing paths.

No routes, schema migrations, worker protocols, or public selection are added.
The digest check does not establish native authority or grant retirement
permission. Future native integration must keep these local refusals intact.
Other well-formed unknown digests retain main's existing behavior. Maintainer
review must decide whether this preparatory boundary should land before its
dedicated worker and admission path or be combined with them.

## Validation and acceptance

Inject the same planned capability digest through the embeddable Java API on
current main and this extraction. This synthetic input qualifies the proposed
refusal boundary; it does not reproduce an existing main production caller or
establish historical private registrations. Recovery tests likewise construct
private handles and registrations as fixtures.
Confirm refusal happens before the storage resolver runs, before a child marker
is created, and before any durable directory entries change. Exercise the
in-memory and durable provisioners, both isolation classes, both provision
overloads, existing and missing resource handles, reconciliation, confirmation,
operator observations, and release. Pin the manifest digest and reject malformed
profile request identities. Existing ordinary local-process and durable-worker
tests must remain green.

Acceptance requires focused Java tests, Checkstyle, SpotBugs, packaging, root
build/typecheck, independent verification, and a full-diff audit on the extracted
branch. These checks establish the local Java boundary only; physical Kubernetes
or CSI lifetime qualification is outside this PR.
