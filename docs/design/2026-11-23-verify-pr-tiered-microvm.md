# Tiered microVM isolation for /verify-pr

[English](2026-11-23-verify-pr-tiered-microvm.md) | [简体中文](2026-11-23-verify-pr-tiered-microvm.zh-CN.md)

**Status: proposal, 2026-11-23.** This document defines a design and PoC acceptance boundary. It does not claim that the backend, gates, or performance goals have been implemented or verified.

## 1. Shortest reading path and decision summary

Read this section, the problem statement and threat model, then the execution tiers in Section 4 and the opening of each decision in Section 6. The second half contains lifecycle, implementation, and acceptance details.

Local `/verify-pr` frequently executes PR-controlled builds, tests, and agent tool calls. Its threat model includes actively malicious PRs and attacks against the host kernel. Linux containers, Bubblewrap, Landlock, and macOS Seatbelt share a kernel with the host and cannot individually address that threat model; running a full VM for every PR also adds friction to frequent maintainer work.

This proposal is **microVM-first, not microVM-only**:

- External, unknown, sponsored, or otherwise unattributed heads, and changes that trigger mandatory escalation, execute in a one-shot hardware-virtualized boundary.
- A local working tree explicitly selected by its owner, and PRs from contributors whose permissions are revalidated, can enter a trusted lightweight tier explicitly labelled as having a lower assurance level.
- The lightweight tier is not another name for the high-assurance boundary: it accepts residual author-account, insider, and supply-chain risk, focusing on accident containment and limiting blast radius.
- No tier falls back automatically to the host. An unavailable backend can only fail, select another backend at the same assurance level, or route to a remote isolated worker.
- Linux uses Firecracker/KVM/jailer on a capable host, or a per-round `provider-vm` on ordinary ECS without nested KVM. macOS uses vfkit/Apple Virtualization.framework, with a working sandbox around the vfkit host process as a mandatory PoC gate.
- The first version does not clone running snapshots, share writable dependency caches, or build multiple native lightweight sandboxes at the same time.

The design separates two questions: **trust classification decides whether shared-kernel residual risk is acceptable; the actual backend determines the isolation claim allowed in the report.**

## 2. Current state and failures to avoid

### 2.1 Existing foundations

- The local Docker recipe in `.qwen/skills/verify-pr/SKILL.md` keeps the real model key in a host proxy and gives the PR only a per-round bearer token. Scripts run from a trusted checkout, and the base `.qwen` is pinned as a trusted input.
- The local container mounts a standalone PR clone read-write, with artifacts in that tree. `scripts/verify-pr-prepare.mjs` and `scripts/verify-pr-check.mjs` define gates around container markers, context digests, symlinks, artifact integrity, and the container nonce.
- `.github/workflows/qwen-triage.yml` separates untrusted execution in `verify` from `publish-verify`, which holds publish/OSS credentials. Reports remain advisory evidence for human reviewers, not automatic approval.
- authorize already distinguishes `verify_trust=trusted` from `external` using collaborator permission. The external path pins `SPONSORED_OID`, revalidates the head and author permission immediately before execution, and adds a risk screen and workspace wipe.

### 2.2 A shared kernel does not meet the new threat

Local Docker and CI containers confine some process and filesystem effects but do not separate the PR from the host Linux kernel. The macOS `permissive-open` default profile is not a credential boundary; even the restrictive profile permits `(allow file-read*)`. The repository's bwrap execution backend uses `--ro-bind / /`, which likewise leaves host files readable. Renaming one of these mechanisms does not turn it into a high-assurance backend.

The CI `verify` job is pinned to a `self-hosted/ecs-qwen` container; only its publisher explicitly uses `ubuntu-latest`. The CI lane can be treated as high assurance only when the runner operator proves that each job has a distinct outer VM that is destroyed afterwards. The outer boundary cannot be inferred from the YAML.

### 2.3 Shared workspaces and credentials are separate risks

The current read-write workspace requires the host to read, inspect, and clean PR-writable paths after PR code has run, exposing symlink and live-process races. Replacing the VMM without changing that input/output relationship preserves the attack surface.

Likewise, absence of a model key from a container does not imply a constrained network. A guest root or an attacker controlling the guest kernel can bypass `HTTP_PROXY`, Maven mirrors, and firewalls inside the guest, so network policy must be enforced outside the VM.

## 3. Threat model, goals, and non-goals

### 3.1 Attacker capabilities

The high-assurance tier assumes that a PR controls source, build scripts, dependencies, tests, background processes, network clients, and output. It can obtain guest root and may exploit the guest kernel. It can attack the VMM, VirtIO/vsock, host brokers, artifact collector, and report format, and can forge any log or test result inside the guest.

### 3.2 Assets to protect

- Host files, kernel, private network, and host services, including SSH, cloud, GitHub, model, and OSS credentials.
- Other projects, concurrent verification rounds, and the golden image and trusted scripts used by subsequent rounds.
- Host and shared-infrastructure CPU, memory, disk, process, network, and model quotas.
- Report head identity, actual execution boundary, and publication credentials.

### 3.3 Security goals

- Hardware virtualization and a constrained host VMM process must separate a PR-controlled kernel from the host kernel.
- No normal verdict is published before VM destruction, and the guest cannot self-certify the credential-free publisher path.
- The host never mounts, executes, or expands filesystem semantics supplied by PR-controlled data.
- The lightweight tier may relax protection against malicious insider code but does not remove basic credential isolation, resource budgets, or per-round cleanup.

### 3.4 Non-goals and residual risks

- The design does not eliminate hypervisor zero-days, VMM side channels, or CPU microarchitectural side channels. Highly targeted attacks require dedicated disposable verification nodes isolated from everyday workstations.
- It does not prove that tests reported by a malicious guest are truthful. VM records establish an execution boundary, not the integrity of tests observed inside it.
- No report is automatically merged, and a guest-generated `merge-ready` never becomes an approval.
- The first version does not support arbitrary images, arbitrary networking, Windows, cross-architecture equivalence, or real production databases.
- Neither a PR author identity nor a maintainer sponsorship substitutes for classifying the current head.

### 3.5 Compatibility constraints for `/review` (considered, unchanged)

`/review` already contains execution of reviewed code in `build-test`, probe/mutation, base-tree, and prose-exec phases rather than merely wrapping the entire reviewing agent. An executor backend must fit that boundary through adapters, preserving `working_dir`, fan-out, coverage/verdict ledgers, cleanup, and the original meaning of its reports. Agents reading a diff and producing findings must not be moved wholesale into a VM that lacks their required trusted context.

- A `scratch-tree` removes cross-run residue but is not a security sandbox. Phases running PR commands require the same execution boundary, real-worker destruction, and execution-unavailable evidence.
- Network capabilities are authorised separately for install, build, and test, while a timeout kills the actual worker rather than only its client. A refusal cannot silently fall back to host execution or become a pass.
- A permitted `--fix` continues to land in the user's working tree: modifying and then destroying a one-shot VM copy does not make a finding fixed. `--fix` on a PR target remains ineffective under the present contract.
- Prose-exec is distinguished from read-only analysis without build steps: untrusted source text does not itself become runtime-verified evidence.

These are prerequisites for eventually sharing an inexpensive executor backend with `/review`, not an integration already underway. This proposal does not require changes to its skill, agent orchestration, or `sandboxed-exec` implementation now.

## 4. Trust classification and execution tiers

### 4.1 Two independent fields

Every round records both:

- `prTrust`: `local-owner`, `collaborator`, `external`, or `unknown`.
- `executionClass`: `hardware-isolated` or `trusted-shared-kernel`.

A `trusted` label alone cannot determine a security claim. Readers must see the actual `executionClass`, head, backend, and reason for classification.

### 4.2 Selection rules

| Input                                                                                                             | Default execution class                     | Reason                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Local working tree explicitly selected by its owner                                                               | `trusted-shared-kernel`                     | Development trust comparable to a normal local build; records the source baseline and does not implicitly cover a remote PR |
| Author currently has `write`, `maintain`, or `admin`, and pre-execution permission and head revalidation succeeds | `trusted-shared-kernel`                     | Accepts residual trusted-contributor and shared-kernel risk                                                                 |
| Fork, external author, unknown membership, or unclassifiable source                                               | `hardware-isolated`                         | Malicious PRs are inside the threat model                                                                                   |
| External PR sponsored by a maintainer `/verify`                                                                   | `hardware-isolated`                         | Sponsorship authorizes spending execution resources; it does not attest that code is non-malicious                          |
| Permission, head, or risk information cannot be read                                                              | `hardware-isolated` or refuse before launch | Classification failures must never reduce isolation                                                                         |
| Mandatory escalation under Section 4.3                                                                            | `hardware-isolated`, regardless of author   | New code may come from a supply chain or instruction source beyond the author                                               |

The local tier applies only to local content explicitly selected by the operator. A GitHub PR displayed as owned by that same person still requires current-head and permission classification. `head.repo == base` is provenance metadata rather than proof of trust because other writers can push to the repository branch.

Trust uses current collaborator permission, not commit author, email, or `author_association` alone. The permission of the `/verify` requester still controls model and runner budget admission; that principal is not conflated with the PR author's trust.

### 4.3 Mandatory escalation

Triggers include dependency manifests, lockfiles, dependency URLs, npm lifecycles, `.npmrc`, `.pnpmfile.mjs`, Maven POMs/plugins, `.github/workflows`, verification or sandbox scripts, `.qwen` skills/commands/executable instructions, new binaries, native extensions, and tools downloaded for execution. Existing external risk-screen criteria for obfuscation or incomplete review remain applicable.

These are escalation signals, **not proof that other changes are safe**. The trusted tier is an explicit choice to accept author and insider-code risk. An external PR can never be downgraded to a shared kernel because a model risk screen returns `clear`.

### 4.4 Trust grants and their lifecycle

- Every execution class pins `headRefOid` at admission, not only the external class. After queueing and before source injection, the head is compared again and author permission is revalidated.
- A changed head is a new run and is classified again; it cannot inherit a lightweight grant for the previous head. Revoked or unreadable permission cannot reuse an earlier trust result.
- Publication applies the existing moved-head rules to the recorded head and latest review state.
- During an active security incident, trusted configuration outside PR code forces `hardware-isolated` for every run. Trusted exceptions reopen only after incident review.
- An unavailable lightweight backend can be upgraded to high assurance; it cannot automatically become a host `waived` run.

## 5. Target architecture

```text
Trusted host: prepare/permission and head → VM launcher → artifact check → isolated publisher
                                  │
                    fixed input/output, model, dependency capabilities
                                  │
                Per-round VM, writable disk copy, and scratch HOME
                                  │
          Released verification agent + PR source + all build/test/file work
```

High-assurance execution shares no host HOME, workspace, Docker socket, or SSH-agent directory. The PR source and the whole verification agent run in the guest. The host handles only metadata, trusted inputs, limited capability brokers, VM lifecycle, and output bytes.

Linux assigns one Firecracker process to one microVM and uses the matching jailer in production. macOS uses the vfkit Linux bootloader with Apple Virtualization.framework. The two backends expose the same trusted launch contract to the upper layers, not the same platform API.

The generic whole-CLI sandbox in `packages/cli` and tool-level execution sandbox in `packages/core` are not substitutes for this design. The first version does not require new public backends in those packages.

### 5.1 Execution placement: both KVM hosts and ordinary ECS are supported

The prevalent execution environment is a cloud VM rather than a workstation with unrestricted `/dev/kvm`. Therefore high assurance must not depend on a single nested-virtualisation mechanism.

| Executing environment                                                                        | Supported role                                                                | Required isolation claim                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KVM-capable local host such as `orangepi6plus`                                               | First-class `firecracker` backend using nested guest hardware virtualisation  | Firecracker/jailer supplies the guest/host split. This is a supported deployment path, not merely a development fallback.                                                                          |
| Apple Silicon/macOS with supported VZ                                                        | `vfkit` backend with an enforcing sandbox around the host VMM process         | Both VZ and the host-process restriction are required; bare vfkit is not enough.                                                                                                                   |
| Ordinary ECS VM without nested KVM, exemplified by `47.97.172.207`                           | Trusted controller, credential broker, and/or lightweight trusted-tier worker | Firecracker is not a prerequisite. A persistent instance can run only `trusted-shared-kernel`; its type or underlying provider hypervisor alone does not create a high-assurance claim.            |
| Provider-created full VM, allocated afresh for a specific head and destroyed after one round | `provider-vm` backend with `executionClass=hardware-isolated`                 | The provider hypervisor is the outer boundary, not a second VM inside the ECS guest. Execution must be pinned to a newly allocated instance, fresh disk/image, and provider-confirmed destruction. |

The same ECS instance can participate as the trusted controller or broker without running high-risk PR code in its own long-lived kernel. If the operator deliberately allocates the instance itself as a single-use execution VM, its disposal is part of the run; using its existing IP or host name is not itself a trust signal. An ordinary persistent ECS cannot satisfy the high-risk requirement merely by wiping its workspace and restarting containers.

A `provider-vm` backend must enforce security groups/VPC policy outside the guest, give the execution VM no IAM role or ambient metadata credentials, keep cloud-management and real model/GitHub/OSS credentials in the trusted controller, and bind create/delete events to the pinned runId and head. No guest-owned property can replace provider launch and termination evidence. Where KVM-backed local execution and provider-managed execution are both available, either may be selected; where neither is available, high-risk execution must refuse or report inconclusive rather than silently dropping to a shared-kernel profile.

For provider VMs that necessarily have a NIC, fixed external gateways and provider/VPC controls replace the local-only no-NIC/vsock transport. The content-only artifact collector and credential-free execution requirements remain unchanged.

**Aliyun `provider-vm` lifecycle PoC, 2026-11-23:** under explicit operator authorization, a single disposable `ecs.e-c1m1.large` instance (`i-bp1e1f9cxtmtff8gz03w`, `0.136 CNY/hour`, 35-minute `AutoReleaseTime` failsafe) with a fresh 20 GiB `cloud_essd` system disk (`d-bp1e1f9cxtmtff8moo87`, `DeleteWithInstance=true`) and a temporary security group (`sg-bp18ywy63h6ned6z7jro`: 0 inbound accepts, explicit egress drops for RFC1918 and `0.0.0.0/0`) was allocated in an otherwise empty VPC (`vpc-bp1htl5oix551ezrx2dgo`, `cn-hangzhou-b`). Provider APIs verified zero public IPs and an empty RAM role; Cloud Assistant (`t-hz073z9h7pctlvk`, exit 0) verified IMDSv1 `403`, IMDSv2 RAM credentials `404`, public and cross-private egress `DENIED`, zero ambient secret hits, and a minimal two-OID A/B check (`base=False`, `head=True`). The publish gate blocked (`isolationIncident=True`) before deletion and allowed `boundary.json (mode:"vm", backend:"provider-vm")` only after provider APIs confirmed `0` remaining instance, disk, and temporary security group while all 8 pre-existing instances stayed untouched. Production provider teardown must retry transient `IncorrectInstanceStatus.Initializing` errors and check `InvocationStatus=="Success"` / `InvokeRecordStatus=="Finished"`. See the P7 Aliyun PoC report (`.qwen/e2e-tests/2026-11-23-p7-provider-vm-aliyun.md`).

**Aliyun Agent Sandbox (`fcsandbox` / E2B-compatible) PoC, 2026-11-23:** under explicit operator authorization, a disposable sandbox (`sbx-f558b247-c11c-4274-a0ed-8a7ded7e4eec`) on `cn-hangzhou.sandbox.aliyuncs.com` (control plane `aliyun fcsandbox 2026-05-09`, data plane `e2b@2.31.0`) cold-started in **2,438 ms** and terminated with list-confirmed absence in **276 ms**. Inside the guest, probes verified KVM hardware virtualization (`FCSB_VIRT=kvm`, dedicated `5.10.134-...kangaroo.al8.x86_64` kernel), 15 GiB ephemeral root disk, zero ambient credentials, blocked Aliyun metadata (`100.100.100.200`), `401` on `169.254.169.254`, and a passing two-OID A/B check, while production `verify-pr-vm-lifecycle.mjs` + `verify-pr-check.mjs` blocked before kill and allowed `mode:"vm"` only after confirmed absence. Crucially, the built-in `code-interpreter-v1` template exhibited `DEFAULT_PUBLIC_EGRESS=OPEN`, so high-assurance PR verification must refuse built-in public templates and require a custom template with `runtimeConfig.internetAccess: false` and an isolated VPC security group (enforced in `buildAliyunAgentSandboxPlan()` along with the observed two-step `UpdateApiKey(inactive) → DeleteApiKey` teardown). See the Aliyun Agent Sandbox PoC report (`.qwen/e2e-tests/2026-11-23-p7-aliyun-agent-sandbox.md`).

## 6. Design decisions: the failure each one prevents

### D1: Put the whole agent and its source operations inside one boundary

**Failure avoided:** builds run in the VM while Read/Write, Git, subagents, LSP, or background jobs return to the host and form a bypass.

The verification agent, source, dependencies, A/B worktrees, builds, tests, screenshots, and temporary files therefore occupy one execution boundary. The host runs no PR lifecycle scripts. The guest can still use bwrap/seccomp as defence in depth, but that is only the second layer.

### D2: Remove shared directories and host disk mounts from the high-assurance tier

**Failure avoided:** a PR plants symlinks or special files or keeps writers alive in a shared directory, and the host later executes, extracts, or mounts those objects.

The golden image is never attached directly to a running VM. Each round receives a writable disk copy that is destroyed afterwards. Linux prefers reflinks, macOS uses APFS clonefile, and a full copy is the safe fallback when CoW is unavailable. A guest can corrupt its own copy but cannot alter the golden image.

There is no read-write bind, virtio-fs, or 9p share for the PR workspace, and the host never mounts a guest disk. Parsing a guest-kernel-controlled filesystem on the host would return the attack to the host kernel.

### D3: Give the high-assurance guest no default NIC; expose fixed capabilities instead

**Failure avoided:** guest root/kernel bypasses proxy configuration or an in-guest firewall and reaches the host, private network, cloud metadata, or an exfiltration endpoint directly.

The first version has no NAT, TAP, or bridged NIC. Guest package managers reach host vsock services through a loopback bridge. Attackers can bypass that bridge, but the host still defines the capability of every vsock endpoint and grants no arbitrary IP access as a result.

The host exposes only three endpoint classes:

- `run-input/output`: input manifest, source, and a bounded report stream.
- `model-broker`: only the configured model upstream and exact API path.
- `dependency-gateway`: only trusted npm/Maven/browser mirrors; no arbitrary upstream proxy.

For every connection, the dependency gateway checks the port, every resolved destination address, and rebinding results. It refuses loopback, private, link-local, and metadata addresses and limits bytes, connections, and time. A dependency that cannot use an approved mirror is reported as not covered or inconclusive; arbitrary networking is not the remedy.

**PoC constraints for local VMM launchers:** the listener socket's ownership and write permissions must be compatible with the unprivileged VMM identity, not only its parent-directory permissions. In `poc-owner-denied`, a root-owned `v.sock_52` at mode 0755 caused real `connect() = -1 EACCES` under UID 65534 and Firecracker translated that to a guest `ECONNRESET`. Changing only that socket's owner to 65534 yielded `connect() = 0` and the complete greeting/ack without widening mode, directory, seccomp, or network access. Production must define a per-run uid/group or scoped delegation rule and include this negative and positive control in admission checks. The prototype also bounded connection recovery by a 15-second overall deadline and 50 attempts with short backoff only for specified connect failures; it did not retry incorrect payloads or bad credentials and must not silently convert an unresolved startup race into success.

A further startup PoC found that `collector-clean-linux-1` produced a 108-byte Linux UDS pathname and failed before any guest or collector case ran. Production must allocate operator-owned, private, short UDS paths and check their byte length, ownership and mode before starting the backend; a long repository or run identifier must not silently turn into a missing-listener security pass. The later `csl1` used an 89-byte pathname and completed the actual VM matrix without lowering isolation. See the collector PoC report (`.qwen/e2e-tests/2026-11-23-collector-workload.md`).

### D4: Separate real credentials from the execution VM and treat each per-round token as leakable

**Failure avoided:** guest root recovers a long-lived credential from the environment, `/proc`, a crash dump, or kernel memory.

GitHub write credentials, OSS credentials, and the real model key are never injected into the guest. The model proxy preserves the existing exact-path authorization, per-round bearer, and idle-watchdog semantics, replacing the per-round token with the real key on the host. The token has single-round scope and a budget, and is revoked when the VM stops.

The publisher retains independent permissions and trusted code provenance. Worst-case exposure of a model token must mean only limited calls for that one round, not repository reads, report publication, or object-store access.

### D5: The collector receives content bytes, not guest filesystem semantics

**Failure avoided:** traversal, links, device nodes, huge files, decompression bombs, or forged gate records in artifacts attack the host.

The guest runner and host collector use versioned frames carrying lengths and digests: `hello`, `file-begin`, `file-chunk`, `file-end`, and `round-end`. The host accepts only contracted text, JSON, logs, and evidence images. Paths are normalized to relative names inside a private per-round vault.

The host accepts no tar, symlinks, permission bits, device nodes, or caller-selected host paths. File count, per-file size, total size, frame size, and read time are bounded before allocating memory. An incomplete frame, limit violation, or disconnect means incomplete output, not absent test results. Terminal control sequences in console output are handled as untrusted text.

`boundary.json`, gate records, or an expected head supplied by the guest never have host authority.

**Follow-up PoC, 2026-11-23:** after removing temporary high-frequency diagnostics, the same host-protocol revision completed 23 fixed cases end to end through the real vSock paths on both KVM/Firecracker (`csl1`, worker `257505` absent after the timeout test) and sandboxed vfkit (`collector-clean-mac-1`, vfkit `13248` absent). The suite includes path and authority-name rejection, file/aggregate/frame budgets, digest and duplicate-name errors, real full-close truncation, regular-file positive controls, one allowed fake-model request, and a live-guest hard timeout. Incomplete or rejected transactions have no pending output in the vault. Full-close and half-close must not be conflated: the half-close form did not provide the expected timely EOF in this transport, whereas a genuine full-close produced host-observed truncation. Oversized frames remain rejected; pending content is drained only by a small bounded amount before connection closure rather than admitting an unbounded payload.

This is a tiny local protocol fixture, not a production collector or a complete network/lifecycle/oracle validation. It uses a short operator-controlled socket path and per-run rootfs copies, includes a dedicated VZ rootfs because the initramfs invokes `/opt/poc/init` directly, and records the separately verified image and executable digests. Genuine pull requests, the formal `/verify-pr` agent and execution record/checker/publisher, real model-token budgets and revocation, DNS rebinding/redirects, fork bombs, launcher crashes, provider VM lifecycle, and production dedicated UID/Seatbelt review remain outside the passing claim. The primary evidence and remaining limitations are in the collector workload report (`.qwen/e2e-tests/2026-11-23-collector-workload.md`).

### D6: Protect the host from the VMM process after KVM on Linux

**Failure avoided:** a malicious guest kernel exploits the VMM or a device and directly obtains the maintainer's host privileges.

Firecracker's default seccomp is not a complete launch recipe. Production also needs the matching jailer, a per-round non-login UID/GID, chroot, mount namespace, required cgroups, and rlimits. Only the current round's disks, kernel, API socket, and vsock-related resources are explicitly supplied to the VMM.

Omitting a NIC in the first version also removes TAP setup and its attack surface. CPU, VMM overhead, actual disk usage, host processes, and wall-clock time are limited on the host; guest-level limits are secondary.

The launcher and its paths belong to the TCB. It exposes no general privileged interface accepting arbitrary image paths, netns names, UIDs, or command lines. Kernel, rootfs, and jailer/Firecracker versions and digests enter the execution record.

### D7: Constrain both the guest and the vfkit host process on macOS

**Failure avoided:** assuming that use of VZ means a compromised VMM still cannot read the everyday user's files.

vfkit uses its Linux bootloader and omits `virtio-net`, `virtio-fs`, Rosetta, GPU, USB/NBD, and other unnecessary devices. Each round uses a private Unix socket for vsock. REST is disabled by default while the launcher owns process lifecycle and proves that vfkit really exited. Only a demonstrated need for an additional controller API may enable REST, using a separate per-round private Unix socket and its own narrowly verified authorization; no generic inbound network exception is added. A failed REST bind must not be reclassified as permission to exempt all listeners.

The vfkit host process runs as a separate ordinary user with a private HOME and restricted file view. A dedicated deny-default Seatbelt profile allows only the Mach services needed by VZ and the current round's images and sockets, denies general networking and other user directories, and receives no Full Disk Access.

This is a **go/no-go PoC** for the high-assurance macOS path. If a target system cannot run VZ correctly while enforcing the host-process sandbox, high-risk PRs must route to a remote Linux microVM worker. The finite policy for vfkit and a policy for arbitrary PR tools under Seatbelt are separate problems; a security conclusion cannot be borrowed from one to justify the other. The first version plans Linux ARM64 guests only on supported Apple Silicon/macOS combinations.

**Minimal PoC result, 2026-11-23:** the original Firecracker CI ARM64 kernel had `# CONFIG_PCI is not set`, so its MMIO success did not transfer to VZ's PCI devices. A candidate preserving MMIO and adding PCI host and virtio-PCI was built from the matching upstream source. Both `vfkit-vz-pci-2` and `vfkit-vz-sandbox-2` then produced real initrd/rootfs/guest-init evidence, only `lo` in guest network enumeration, and complete guest-to-host greeting/ack followed by process cleanup. The sandboxed run's file-positive and outside-canary-denied checks passed, and `live_vfkit_processes=[]` at the final snapshot. Dedicated production-UID/custom Seatbelt review is still pending; this is not a completed maintainer deployment configuration. Detailed counters and source hashes are in the PoC results (`.qwen/e2e-tests/2026-11-23-verify-pr-tiered-microvm-results.md`).

### D8: Run one PR per round and do not reuse running-state snapshots initially

**Failure avoided:** processes, kernel state, tokens, a forged agent, or malicious disk state persist into the next round; snapshot clones also duplicate entropy and identity.

The VM, writable disk, HOME, and token belong to exactly one runId. A VM that ran a PR never returns to a warm pool. Clean disks or VMs can be prepared before assignment, but each is allocated only once.

**Lifecycle correction from the Firecracker PoC:** the supervisor process is not necessarily the actual VMM worker. After waiting only on the supervisor, this PoC found orphaned workers `31063` and `38868`, both still executing `/firecracker-v1.18.0-aarch64` with host/namespace PID pairs. They were identified from jailer PID files and explicitly stopped and confirmed absent. Production must resolve the real worker PID from a launcher-owned PID record, validate its executable identity, then restrict tracing and termination to that worker. A bounded wait must prove the worker is no longer alive; an untracked or surviving PID fails cleanup rather than earning a nominal teardown completion field. The corrected baseline (`poc-owner-allowed`) observed worker `44980` absent and a final empty Firecracker process snapshot.

Firecracker's snapshot documentation requires handling guest identifiers, entropy, randomness, tokens, and network/vsock uniqueness. The first version cold-boots with new per-round identity. Golden-image construction removes persistent machine identifiers, guest host keys, and saved random seeds; each first boot reconstructs identity and supplies entropy from a host random source. Cold boot alone does not prove disk-clone uniqueness. If measurements justify running-state snapshot restore, a separate design must establish unique identity, fresh entropy, CID/port separation, and disk quotas.

**Concurrent two-OID cold-boot PoC, 2026-11-23:** running two microVMs simultaneously (`cca1` and `ccb1`) from the same 256 MiB source rootfs on both KVM/Firecracker (live overlap `306761` & `306768`) and sandboxed vfkit (live overlap `25546` & `25549`) produced distinct `/etc/machine-id` values and 32-byte random samples per round, zero cross-round canary or OID leakage, real Node v22.23.5 two-OID A/B results (`base` exit `1`, `head` exit `0`) delivered over vsock without sharing host `.git`, per-round model-token isolation (cross-round token `403:invalid-token`, valid token `200` with fake upstream secret absent from guest/report, post-teardown replay `403:token-revoked`), and host-written `boundary.json (mode:"microvm")` after destruction. Full `qwen` CLI runs, 10-run cold-start benchmarks, dependency gateways, and cryptographic entropy audits remain outside this fixture. See the concurrent two-OID PoC report (`.qwen/e2e-tests/2026-11-23-p56-concurrent-two-oid-workload.md`).

### D9: Replace guest self-certification with a host execution record

**Failure avoided:** a guest forges the boundary, copies a nonce after tests ran elsewhere, or publishes while the VM is still alive.

The trusted launcher maintains `execution-record.json` outside guest-writable storage. It records runId, repository, PR, base/head, context digest, backend/version, platform, kernel/golden-image digests, trusted-input digest, CLI/skill versions, normalized launch-policy digest, start/end/destruction times, and teardown and output status. For a local backend, it distinguishes the supervisor/worker identifiers and records worker identity and the observed exit or provider-confirmed teardown evidence. `teardownStatus=destroyed` requires that proof, not merely a supervisor exit or a self-reported launch declaration.

For nested local execution, the report's `boundary.json mode:"microvm"` can only be written by the host after the VM has stopped and been destroyed. For a provider-managed full VM, `mode:"vm"` must identify `backend:"provider-vm"` and the trusted controller must record the allocation identity, fresh image/disk identity, bound runId and head, and provider-confirmed termination state. An existing or reused VM with no provider lifecycle evidence is not a provider round and cannot use this equivalence.

The checker reads the execution record from an explicit host path. It cannot derive a trusted boundary from the PR-writable artifacts or a self-selected argv claim. This is an operator record, not TPM, SEV, or another remote-attestation claim.

### D10: Stop publication on a security-gate failure rather than choosing a weaker interpretation

**Failure avoided:** an undestroyed VM, truncated output, or reduced policy is labelled as passing with a warning.

Normal `merge-ready` is unavailable when cleanup, output framing, or the execution record is incomplete. Cleanup failure identifies an isolation incident that requires operator attention to orphaned resources. Without KVM/VZ, local high assurance is refused or routed remotely rather than silently becoming Docker, bwrap, Seatbelt, or host execution.

**Execution-record and fail-closed publish-gate PoC, 2026-11-23:** a standalone PoC publish gate passed 20 single-variable allow/block contract cases on both macOS (Python 3.9) and Linux (Python 3.11), covering output truncation/timeout, teardown failure, live worker PID detection, hardlink/symlink/in-vault record rejection, SHA-256 mismatch, moved head, trust/backend escalation mismatches, `provider-vm` lifecycle proof (contract-only, no cloud API calls), and explicit preservation of `trusted-shared-kernel` labels. End-to-end across both KVM/Firecracker and sandboxed vfkit, four live microVM scenarios (`ok`, `trunc`, `alive`, `forge`) confirmed that only a complete round whose worker is verified absent and disk deleted earns a host-written `boundary.json (mode:"microvm")`, while truncated output, forged `boundary.json` submissions, and a live worker PID (including an adversarial record falsely claiming `teardownStatus="destroyed"` while Linux worker `279874` / macOS vfkit `21406` was still alive) are blocked fail-closed with `isolationIncident=true` and no `boundary.json`. The corresponding host checks are now implemented in `scripts/verify-pr-check.mjs`, `scripts/verify-pr-prepare.mjs`, and `scripts/verify-pr-vm-{collector,lifecycle,runner}.mjs`; CI workflows and `/review` remain unchanged. See the publish-gate PoC report (`.qwen/e2e-tests/2026-11-23-publish-gate-workload.md`).

## 7. Lifecycle, inputs, and outputs

### 7.1 Sequence for one round

1. The trusted host uses prepare to resolve repository/base/head, review snapshots, and context digest, then selects the trust class.
2. It builds a Git pack/bundle containing both OIDs and their required history, base-pinned `.qwen`, trusted scripts, and an input digest without running lifecycle scripts.
3. It allocates a private run directory, per-round disk, resource limits, fixed vsock endpoints, model token, collector, and overall deadline.
4. After validating digests and the minimal device set, it starts a clean VM from a working copy of the golden image.
5. The guest materializes both OIDs and runs the released verification agent with a per-round scratch HOME.
6. The collector receives the bounded report stream; PR background jobs cannot extend the output phase indefinitely.
7. The host hard-stops the VM, confirms VMM exit, revokes the token, closes endpoints, and deletes the working disk.
8. With the execution record in hand, the host runs the trusted checker and publish guard, followed by the independent publisher.

### 7.2 Directory trust relationships

The host separates at least:

- **launcher-owned:** execution record, context, input manifest, secret-broker coordinates, and cleanup state; never guest-writable.
- **output vault:** the only destination where the collector writes report content, outside the PR Git workspace.
- **guest-owned:** PR source, `.git`, dependencies, build products, and guest-round artifacts; destroyed with the working disk.

The new microVM checker path does not depend on the legacy container rule that artifacts reside beneath `--context-root`. Legacy container reports remain compatible, but the external vault cannot simply be converted back into a PR-writable root.

### 7.3 Cleanup after launcher failure

The launcher records ownership of processes, cgroups/scopes, disks, sockets, and tokens by runId, with idempotent cleanup. If the launcher crashes, the reaper cleans only resources named by that record. It never broadly kills processes merely named `node`, `qwen`, or `firecracker`.

**P4 resource and crash-recovery PoC, 2026-11-23:** a standalone `poc-reaper.py` passed 4 unit checks on both macOS and Linux (exact PID cleanup preserving a concurrent innocent canary, refusal on executable identity mismatch, refusal on paths outside approved PoC prefixes, and refusal on symlink token files; fixed zombie-state `Z`/`X` handling so exited processes are not misread via `kill(pid, 0)` alone). Across both KVM/Firecracker and sandboxed vfkit, three live microVM scenarios passed: (1) `fork-bomb` spawned 3,810 (Linux) / 3,786 (macOS) guest processes until `EAGAIN` without expanding the host process table (`386→388` with `vmm_threads=3` on Linux; `849→851` on macOS); (2) `disk-fill` hit `ENOSPC` at 16 MiB free inside the 256 MiB working copy while leaving source rootfs digests unchanged and leaving no residue on the next boot; (3) `launcher-crash` delivered a real `SIGKILL` to the running launcher, verified the orphaned VMM worker (`296393` Linux / `23635` macOS), working disk, and unrevoked token survived, then reaped all three via `poc-reaper.py` (`SIGTERM` escalating to `SIGKILL`) while the parallel innocent canary (`296352` Linux / `23617` macOS) stayed alive and a second reaper run remained idempotent. Console-log flooding, multi-phase crash injection, and concurrent multi-VM contention remain unverified. See the P4 PoC report (`.qwen/e2e-tests/2026-11-23-p4-resource-reaper-workload.md`).

## 8. Failure semantics and emergency control

| Condition                                                              | Required result                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| KVM/VZ, jailer, or vfkit host sandbox unavailable                      | Refuse local high assurance or route remotely; do not execute the PR                            |
| Image, input, or launch-policy digest mismatch                         | Refuse before injecting PR data                                                                 |
| Network destination outside the allowlist                              | Reject and audit the request; mark a required missing capability as not covered or inconclusive |
| Fork bomb, disk exhaustion, excessive logs, or model-budget exhaustion | Limit or stop the current round without affecting other rounds                                  |
| Truncated frame, invalid path, forged boundary, or bad digest          | Do not accept output as a normal complete report                                                |
| VMM cannot stop, token cannot be revoked, or disk cleanup fails        | Block normal publication and report an isolation incident                                       |
| Head or execution-time trust classification changes                    | Do not carry the earlier lightweight grant to the new head; reclassify                          |
| Lightweight backend unavailable                                        | Upgrade to high assurance if possible; never automatically use the host                         |
| Active or unscoped security incident                                   | An external trusted switch forces `hardware-isolated` and disables trusted exceptions           |

Incomplete output can be retained as quarantined forensic material, but unexecuted or unknown checks cannot be counted as passes. A policy event does not automatically prove malicious author intent, because a normal dependency can also trigger it; reports should record the actual event precisely.

## 9. Images, resources, and performance

Golden images are built and published only by a trusted pipeline and selected by digest. The base toolchain approximates the current `node:22-bookworm` verification environment with required Git, shell, certificates, and build utilities; the Java profile adds trusted JDK/Maven versions. The released CLI version and skill digest enter the execution record.

The first minimal implementation has no arbitrary PR image field, shared writable Maven/npm cache, running-state snapshot, or dynamic device configuration. Browser downloads are restricted to trusted mirrors; text-only reporting remains available when the browser cannot be supplied, as in the current lane.

CPU, memory, disk, logs, model calls, and VM concurrency use host-defined profiles that the PR cannot modify. Exact numbers are chosen from real JS and Java measurements rather than guessed before the PoC.

Performance reports separately measure VM boot, input materialization, dependency installation, verification, output, and destruction rather than a single end-to-end duration. Comparisons include the current Docker path and at least one TypeScript verification scenario. Total time still has to fit the existing agent/job budgets. Measurements determine whether later work needs a clean-disk pool, a trusted read-only package mirror, or clean-VM prewarming.

**10-run cold-start benchmark PoC, 2026-11-23 (small 256 MiB fixture, N=10, median only; no p95 claim):** Linux Firecracker/jailer measured `diskCopy` 285.6 ms on non-CoW `ext4`, `bootToInput` 294.0 ms, `workload` 256.3 ms, and `destroy` 1070.8 ms (~1 s attributable to two 0.5 s poll intervals in the PoC Python bridge shutdown) vs 749.2 ms median for same-fixture Linux `docker run --rm --network=none` (`trusted-shared-kernel`). macOS sandboxed `vfkit` measured `diskCopy` 4.8 ms on APFS (`cp -c`), `bootToInput` 506.1 ms, `workload` 155.3 ms (preserving one 2271.0 ms outlier on `bm08`), and `destroy` 1061.5 ms vs 331.1 ms median for macOS Docker running inside a persistent Ubuntu 24.04 Linux VM. Clean cold boot itself costs 0.3–0.5 s, confirming that running-state snapshot cloning is unnecessary for v1; on larger Linux images, CoW reflinks or a clean unused disk pool will matter far more than snapshot reuse. See the cold-start benchmark report (`.qwen/e2e-tests/2026-11-23-p6-cold-start-benchmark.md`).

## 10. Implementation stages and affected areas

### Stage 0: Freeze trust rules and execution evidence

Land this design and the PoC contract, and establish the actual security incident status and evidence for disposable outer VMs on ECS. Trusted exceptions remain off during this stage.

### Stage 1: Minimal platform PoCs

First prove that the macOS vfkit host-process policy is enforced, then implement a minimal Linux Firecracker/jailer cold boot. Use purpose-built adversarial fixtures without real credentials: no NIC, directory share, or runtime snapshot.

### Stage 2: Execution substrate and host records

Implement shared input/output, vsock capabilities, the collector, execution records, resource limits, and crash recovery. Start with standard TypeScript work and preserve the existing model-proxy semantics.

### Stage 3: Trust routing and report gates

Name `prTrust` and `executionClass` explicitly in existing authorize/prepare/checker flows and add the microVM boundary path while retaining legacy reports. The lightweight tier initially continues to use the audited container path rather than simultaneously introducing another general bwrap or Seatbelt agent backend.

### Stage 4: Capability and CI parity

Add Java, Maven, and browser capabilities. CI must move PR install/build/agent execution into disposable VMs; moving only the final agent while continuing PR builds in a container on the shared host does not meet the threat model. Run every affected workflow meta-test.

### Stage 5: Measure, optimize, and switch defaults

Open trusted exceptions and default routing only after security acceptance and independent review. Add caches or clean prewarming only for measured bottlenecks; never reuse state that has run a PR to improve startup numbers.

Likely affected areas include `.qwen/skills/verify-pr/SKILL.md`, `scripts/verify-pr-{prepare,check,guard,watch-gate,model-proxy}.mjs`, new trusted runner/guest and image-build code, their collocated tests, `.github/workflows/qwen-triage.yml`, every `scripts/tests/` meta-test that references it, this design, and `.qwen/e2e-tests/`. The exact new modules are decided after the PoC rather than becoming a premature general framework.

## 11. Validation strategy

The detailed PoC plan is in `.qwen/e2e-tests/2026-11-23-verify-pr-tiered-microvm.md`.

Validation proceeds in order: platform-capability liveness, positive controls proving probes can detect risk, negative refusal checks, lifecycle and cross-round evidence, then a real small verification and performance measurements. Checking that a host path is absent or reporting an assertion that never ran is not security evidence.

The prototype first runs without real keys, PRs, or production network access. It does not exploit actual kernel CVEs; configuration acceptance therefore does not replace an independent security review of the VMM/jailer/vfkit setup, network-destination checks, and collector.

Implementation must subsequently run unit tests, build, typecheck, lint, workflow meta-tests, and genuine end-to-end verification according to repository rules. Adding this document does not claim completion of any of those checks.

## 12. Acceptance criteria

1. External, unknown, sponsored, or mandatory-escalation inputs can enter only a hardware boundary; unknown input never silently becomes trusted.
2. Collaborator, head, execution class, and escalation reasons are recorded, and a changed head cannot inherit a lightweight grant.
3. Neither guest user nor guest root can read a host canary, connect to a host canary service, or modify the golden image; positive controls prove those probes are live.
4. Model and dependency gateways reject arbitrary destinations, and private, loopback, link-local, metadata, and DNS-rebinding destinations are denied outside the VM.
5. No real model/GitHub/OSS credential appears in the guest environment, inputs, or outputs; each token is unusable after teardown.
6. Traversal, links, forged gates, oversized output, and malformed frames neither escape the vault nor become a false complete report.
7. A fork bomb, full disk, or resource limit cannot exhaust the reserved host margin or clean up another round's processes.
8. After interruption at every phase, the reaper can clean by runId; an undestroyed VM or incomplete output cannot publish a normal verdict.
9. Concurrent PRs cannot observe one another's disks, sources, credentials, reports, or execution records.
10. macOS proves that the vfkit host sandbox is really enforcing, otherwise local high assurance remains unavailable and routes remotely.
11. A trusted lightweight report explicitly states `trusted-shared-kernel` and cannot be mistaken for a high-assurance result.
12. Representative verification has sufficient capability coverage, and staged performance data exists before caching or snapshot optimizations are selected.

## 13. Alternatives and tradeoffs

- **Containers or native bwrap/Seatbelt everywhere.** Lightest, but cannot answer malicious attacks against the host kernel; rejected as the only solution.
- **microVM for every run.** Simplest security rule, but removes cost relief for local-owner and trusted-contributor work; remains available as the strictest configuration.
- **Automatic host execution based on author permission.** Accounts can be compromised, branches can contain others' code, and sponsorship is not endorsement; rejected.
- **Downgrade after a `clear` risk screen.** A risk screen is not proof of malicious-code absence; rejected.
- **Permanently nesting Docker inside a VM.** Useful as a quick migration step but retains two layers of complexity; transitional only.
- **gVisor or rootless Podman alone.** Useful as defence in depth or a trusted-tier backend, not as the high-assurance hardware boundary.
- **Bare vfkit on macOS.** Provides the first guest/host boundary but leaves maintainer privileges exposed if the VMM is compromised; a host-process sandbox is a prerequisite.

## 14. Open questions

- The class, blast radius, and postmortem state of the reported incident, and when trusted exceptions may safely reopen.
- Whether the ECS runner operator can prove an exclusive VM per execution, no cross-round reuse, and no host credentials entering it.
- Whether vfkit + Seatbelt works and actually enforces on the target macOS releases. The initial designated fallback is a remote Linux worker.
- The minimal mirror destination set for dependencies, especially Maven, npm tarballs, and Playwright/Chromium.
- Which remote worker serves machines without supported hardware virtualization or a working macOS PoC, including scheduling, auditing, and model-cost ownership.
- Exact resource profiles and performance thresholds after cold-start and representative-workload measurements rather than beforehand.
- Whether trusted contributors default to the lightweight tier after an incident. This proposal reopens that default only after review and always retains a global hardware-only switch.

## 15. References

- Current verification contract: `.qwen/skills/verify-pr/SKILL.md`, `scripts/verify-pr-prepare.mjs`, `scripts/verify-pr-check.mjs`, and `scripts/verify-pr-model-proxy.mjs`.
- CI trust and execution/publication separation: `authorize`, `verify`, and `publish-verify` in `.github/workflows/qwen-triage.yml`.
- [Firecracker design and threat model](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md).
- [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md).
- [Firecracker vsock](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md).
- [Firecracker snapshot uniqueness and limitations](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md).
- [vfkit Linux boot, raw disk, vsock, REST, and device options](https://github.com/crc-org/vfkit/blob/main/doc/usage.md).
