# Shared Harness Kubernetes qualification tools

[English](2026-10-25-managed-harness-kubernetes-qualification.md) | [简体中文](2026-10-25-managed-harness-kubernetes-qualification.zh-CN.md)

## Problem and current state

The shared Harness pool is implemented, but its deployment templates require manual image, identity, settings and scheduling edits. The stock Java image contains the Server JAR without Node or the complete CLI required by local-process Runtime workers. Existing process failover tests start their own Java and database processes; they cannot qualify an external Kubernetes pool. Passing those tests does not prove public multi-user authorization, physical tool effects or event reconnection on two Pods.

The initial target has zero business workers. Its two existing system nodes are reserved with `CriticalAddonsOnly`; submitting unrestricted pending Pods could provision paid nodes. This implementation must remain usable without granting that exception or purchasing infrastructure.

## Proposed changes

| Component                | Change                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image builder            | Build the existing Harness and Java images from one immutable Git archive, then derive a Java-plus-worker qualification image carrying the same complete CLI. Publish only when explicitly requested and record published repository digests separately from local image IDs.                                                                |
| Deployment renderer      | Fill the existing Harness templates from a non-secret configuration. Render two replicas, immutable images, namespace ownership and placement restricted to two explicitly named existing business nodes. Keep a third rollout Pod schedulable within those two nodes using topology spread. Do not render an HPA or system-node toleration. |
| Public acceptance runner | Reuse the production signing helper. Create owned Workspaces and Sessions for two tenants with two actors each; check replay, negative authorization, file effects, approval decisions, cancellation and real SSE resume through the public surfaces. Bound requests, event frames and waits.                                                |
| Read-only preflight      | Promote the existing qualification check into a tracked script. Verify node eligibility, rollout/controller identities, image references, probes and EndpointSlice targets before accepting deployment readiness. Readiness is reported separately from execution acceptance.                                                                |

## Decisions and boundaries

Java and its embedded Broker keep local-process workers in the Java container; the two Harness Pods receive no tenant Workspace mount. The derived image provides Node, the complete packaged CLI and ordinary command dependencies. Its three state/Workspace directories remain separate. It does not enable privileged containers, host paths, delegated host cgroups or trusted reboot recovery. Background Shell, Monitor and Hook profiles require separate cgroup qualification.

Rendering and preflight never apply resources or modify node pools. Deployment requires verified node capacity, operator-supplied Secrets, actual Pod-IP SAN certificates, Java client identity, trusted HTTPS Store/Broker/model endpoints and a fresh single-V1 catalog. These inputs remain explicit; generated YAML cannot substitute for them. Published image digests and source provenance must be reviewed before deployment.

The bundle includes one run-owned cluster-scoped PriorityClass with priority -1000, `globalDefault: false` and `preemptionPolicy: Never`. Pods reference it because priority admission requires a matching policy. Applying it needs cluster permission; cleanup removes this class after its Pods. Required node affinity uses two OR terms, each with one `metadata.name` value. Preflight verifies the exact class, ownership and both singleton alternatives, accepting reordered terms but refusing duplicates, extra constraints or other nodes.

The public runner uses a disposable namespace and dedicated actors, agent definitions and Workspaces. It does not synthesize Session SQL rows, provision grants, enable new profiles, bypass authentication or automatically retry failed mutations with different keys. File content comes from the Workspace file API, not model text. Shell permission decisions must offer the requested option and retain their original revisions. SSE IDs are Session-local numeric offsets; isolation is checked using the authenticated Session and payload ownership.

The runner records component results and unfinished gates. It does not infer two-Pod coverage from Session count, physical storage release from process exit, or safe owner takeover from readiness. Actual placement/boot/writer/release receipts and the busy-Pod, crash, unknown-effect and lost-ACK matrix remain operator acceptance inputs. Capacity and HPA are last; automatic scale-in stays disabled.

Foreground Shell uses the existing Tool v3 publication protocol with a real private OSS backend and a private HTTPS publication route. The legacy capture callback binds Harness loopback and is not a cross-Pod transport. Qualification supplies explicit capacities/deadlines, Java-only temporary OSS environment credentials, worker CA trust and actual network destinations. This does not introduce a new publisher protocol or qualify background/Monitor/Hook lifecycles.

## Validation and acceptance

Test the renderer against the actual templates, including digest rejection, reserved-node refusal, explicit node affinity and rollout spread. Test the public runner against a signed HTTP contract fixture that fragments SSE and detects replay or scope mistakes; injected wrong Session IDs, duplicate terminals and missing physical effects must fail. Those fixtures validate the tool itself and are not Kubernetes acceptance.

Build and typecheck the repository for the changed JavaScript consumers and run the affected script tests. No Java source changes are needed. Reuse applicable Java CI evidence; the shared local Java budget remains exhausted. Container builds and actual cluster cases require a remote Docker builder and an authorized eligible target. Keep unexecuted container/live/fault checks explicit.

## Open inputs

An eligible worker target or explicit temporary-node cost authorization, remote Docker access, registry write access, TLS issuance, private service endpoints, fresh database credentials and enabled agent IDs must be supplied before live deployment. Do not purchase resources or relax system-node policy as a side effect of these tools.
