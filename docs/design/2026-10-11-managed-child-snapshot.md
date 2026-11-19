# Managed child snapshot and serialized sharing (isolation slice, I3)

[English](2026-10-11-managed-child-snapshot.md) | [简体中文](2026-10-11-managed-child-snapshot.zh-CN.md)

Status: implemented in this change. Landed: a hosted child agent may run as a read-only snapshot of its parent's Workspace (`isolation: "snapshot"`). The child reads a frozen copy, a child Workspace that is always discarded, through a tool profile that declares no writing tool. The serialization decision is final: serialized sharing has no value of its own. This is I3 of [#13753](https://github.com/QwenLM/qwen-code/issues/13753). It builds on I1 ([child Workspace capability](2026-10-09-managed-child-workspace.md), #13781) and I2 ([worktree admission](2026-10-10-managed-child-worktree-admission.md), #13841, with its follow-up #13872).

## Problem and scope

Issue #13753 asks two things of I3:

- **The view.** "A read-only frozen view of the parent binding, if a provider can offer one." Exit check: "A `snapshot` child cannot write."
- **Serialization.** "A decision on whether a per-child generation/barrier is needed beyond the Workspace lease, and if so, the value that names it." Exit check: "Two serialized children of one parent cannot hold the same generation at once, or the decision records why the lease already guarantees it."

The direction was recorded in I1 decision 15: `snapshot` reuses the child Workspace capability, and the child's tool profile refuses every write. I1 left one question open: is a profile-level refusal enough evidence of "cannot write"? This design answers it and settles the details. The maintainer decided on 2026-10-11:

- the refusal is a read-only hosted profile over a discarded child Workspace, not an OS-level read-only sandbox;
- the profile declares `read_file` and `glob` only.

## Current state

The facts below are from `main` at `415925cbda`, after the schema consolidation (#14069) moved child Workspaces into `ma_workspace` (kind `CHILD_GIT`) with their step state in `ma_operation`.

**Profiles.** The hosted tool profiles are `hosted-workspace-files/1..2` (`read_file`, `write_file`, `edit`, and `glob` on `/2`), `hosted-workspace-shell/1..2` (adds `run_shell_command` and `monitor`) and the team lead's Shell profile `hosted-workspace-team-lead/1`. Creation, load and Workspace recovery read one vocabulary (`hosted-workspace-profiles.ts`).

**The one enforcement point.** The hosted tool turn refuses any call whose name is not declared, before the Broker is acquired, and ends the Turn (`prepareRequests` in `hosted-workspace-tool-turn.ts`). Nothing below it enforces a profile:

- the Broker checks payload shapes only;
- the worker builds every file and shell tool in YOLO mode.

**No OS sandbox.** Nothing in the hosted path runs a tool inside one.

- The local-process Broker starts the worker with a plain `ProcessBuilder`, as the control plane's user.
- The per-command `tools.executionSandbox` (bwrap or Landlock, which can mount read-only) is Linux-only, and `qwen serve` refuses to start with it.
- A shell therefore runs unconfined.
- A child Workspace lies inside the parent's storage, so a child's shell can reach the parent's tree.

**Children.**

- **Profile.** A child Session copies its parent's `tool_profile` and `approval_mode` in `ManagedAgentStore.insertChildSession` (`INSERT … SELECT`). Children exist only under Shell-laned parents, so every child today has `run_shell_command`.
- **Relay.** `ChildResultRelay` treats a run as isolated exactly when `workspaceMode` is `worktree`. Any other mode, `snapshot` included, would create the child in the parent's directory.
- **Admission.** TS refuses `snapshot` at admission (`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` is `['shared', 'worktree']`). The record contract in both languages already accepts the value.

**Messages and lanes.**

- A child receives Session messages (H4d-b) only through its own message lane, which exists only on Shell lanes.
- A Session without the lane answers the message route with `409 hosted_messages_unavailable`.
- The parent's `send_message` sends to any running child today.

**Lease.** One storage lease serializes every writer of a storage: the parent, `shared` and `worktree` children, and child Workspace maintenance (I1 decisions 1 and 10, H4b decision 3).

## Decisions

1. **The model opts in, per launch.** The managed `agent` tool's `isolation` argument gains a second value, `"snapshot"`.
   - **Where it shows.** It appears only on a host that serves snapshots (decision 2). There the enum is `["worktree", "snapshot"]`; on a host that serves only child Workspaces it stays `["worktree"]`. The team variant (H4e-b1) gains it the same way.
   - **The record.** The launch records `workspaceMode: "snapshot"`, the fixed key and value H4a already defined, so every revision and replay carries it. `MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` becomes `['shared', 'worktree', 'snapshot']`.
   - **What the model is told.** The declaration says the child needs a Git repository, reads a frozen copy of this Workspace taken when it starts (decision 3; a change the child must see is made before the launch), cannot change files, runs no commands and takes no messages. A refusal for want of snapshots never suggests a launch that can write as the remedy. The team declaration adds that a member cannot be a snapshot (decision 6).

2. **The capability has its own switch.**
   - **Configuration.** A new operator property, `qwen.managed-agent.runtime-broker.child-snapshots-enabled` (default off), requires `child-workspaces-enabled`; startup refuses it alone. When on, Java adds `childSnapshots: true` beside `childWorkspaces: true` on every hosted create and load request, as I2 decision 2 added its flag.
   - **Admission.** TS admits `snapshot` only on a Session whose last proven create or load carried both flags. Otherwise `admitChildLaunch` refuses it as `workspace_mode`, before anything commits. A replayed launch is never re-admitted. A continuation re-admits like any launch. Like `worktree`, the value passes argument validation on every host, so a launch committed while the host served snapshots still replays after the switch is off; a host without the switch therefore refuses a new snapshot launch at admission, with a sentence of its own, where it used to answer an argument error.
   - **Why a switch of its own.** A replica from before this change treats `snapshot` like `shared`: it would create the child in the parent's directory with the parent's Shell profile, a writer.
     - Child Workspaces may already be enabled when this change rolls out replica by replica. During that rollout, a new replica could advertise snapshots while an old one claims the run.
     - The switch gives the operator the moment to turn snapshots on: after every control-plane replica runs this change.
     - A replica from before this change keeps running after a newer one migrates the database, but it cannot start again once a server from #14316 on has migrated it: its startup schema check refuses the columns those migrations add. The window the switch guards therefore lasts until the last replica started before the upgrade is replaced.
     - Turning it off later stops new admissions only. A committed snapshot run still runs as a snapshot.
     - The same holds for a rollback: before moving any replica back below this change, turn the switch off and let every unsettled snapshot run settle (or its parent close), including runs still creating their child, which have no child Workspace row yet. A Turn that started before the switch went off keeps the capability it started with, so wait for running Turns to end before that check. An older relay would create a pending one as a shared writer and would leave its copy until the parent closes. A control-plane replica can move back below this change only on a database that no server from #14316 on has migrated; on any other, the older server refuses to start. An older `qwen serve` refuses the read profile, and Workspace recovery checks every Session of a storage, closed ones included, so its recovery of a storage that holds a snapshot child Session aborts even after that Session closes. Rolling the CLI back below this change gives up Workspace recovery of those storages.

3. **The frozen view is a child Workspace.** The relay prepares a snapshot run's child Workspace exactly as it prepares a worktree run's (I2 decision 3).
   - **What it carries.** The base is I1's snapshot commit of the parent's working tree: tracked and untracked files, not ignored ones.
   - **When it is taken.** When the child Workspace is prepared, which takes the storage lease (I1 decision 10). A foreground launch is refused while its Turn holds the mount, and its Turn waits for it, so no Turn of the parent changes the tree before its copy; a sibling's merge or a `shared` sibling's tool turn still can. A background launch's copy can fall either side of the launching Turn's later changes: preparation waits while the Turn holds the Workspace, but a Turn whose batch held none may write after the copy is taken. From then on the copy is frozen. The model is told it is taken when the child starts, and to make any change the child must see before launching it.
   - **Binding.** The child Session is created in the copy.
   - **Refusals.** A refused layout (no Git repository, a sparse checkout), a blocked preparation, a host without the capability, or a parent that cannot admit the row settles the run `creation_failed`, never started, as for `worktree`.
   - **Why a copy.** The view stays as it was at launch while the parent goes on writing, and the parent's tree is never the child's working directory.

4. **"Cannot write" is the profile, and the store sets it.**
   - **The profile.** A new hosted profile, `hosted-workspace-read/1`, declares `read_file` and `glob` and nothing else, whatever lanes, child orchestration or MCP the Session has: no `write_file`, `edit`, `run_shell_command` or `monitor`, no Agent or team tool, no `send_message`, no MCP tool and no `skill` tool. A read-profile Session takes no skill catalog from its agent definition either: the catalog's instructions would name a tool the profile refuses, and an undeclared call fails the Turn.
   - **Who sets it.** `insertChildSession` gives a child the read profile whenever the child Workspace row it binds records `snapshot`. It reads that row in the same transaction that checks it is ready, so no caller can bind a snapshot copy to a writing profile. Only the profile changes; the approval mode is still the parent's.
   - **Approvals.** `read_file` and `glob` are pre-approved under `default` and `auto-edit`, so a snapshot child asks nothing of its own.
   - **Hooks are kept (#13905 item 37).** A child Session takes its parent's agent definition, so since #14319 a snapshot child runs its parent's hook catalog, as any child does.
     - **Why.** A hook catalog is the operator's policy, not the model's choice. A `PreToolUse` hook can deny a `read_file` or `glob` call or rewrite its input, for example to keep a secret from being read. Without its hooks, a snapshot child would read what the same agent is refused everywhere else, whenever the model chose `isolation: "snapshot"`. The skill catalog is dropped for a different reason: its instructions name tools the profile refuses, while a hook offers the model no tool.
     - **What it costs.** None of it is particular to snapshots:
       - a `PreToolUse` hook may ask, so the child can wait on an approval like any child;
       - a hook command runs with the copy as its working directory, so what it writes within the copy is discarded with it. It is not isolated, though: a write outside the copy, such as a log at an absolute path, and any other side effect outlive the discard;
       - a turn resumed after its Runtime was replaced reacquires through the Session's Hook owner instead of taking decision 8's step-3 path, which serves only Sessions with neither hooks nor MCP, as for `hosted-workspace-files/1`;
       - once a command, http or function hook runs, the child's Hook owner holds the storage until the child Session closes, as a Hook owner does in any Session, so the parent's tool turns and its other children's wait until then. A turn blocked for recovery can release it earlier: once its hook work is proven settled or never dispatched, the owner hands the mount back while the Session stays open.
   - **What makes it hold.** Each piece already holds for every hosted Session:
     - the declaration set carries no tool that writes;
     - the tool turn refuses any other name before the Broker is acquired, and ends the Turn;
     - file paths are relative to the child's directory in the copy and reject absolute and `..` segments.
   - **What this does not claim.** It is not an OS boundary. An OS-level read-only sandbox was weighed and not taken. Nothing in the hosted path has one, the only implementation is Linux-only, and `qwen serve` refuses it. With shell kept, it would also have to confine a process inside the parent's storage. Without a shell, nothing in the child's surface writes. The copy also lies inside the parent's storage, so it is frozen against the control plane and the child, not against the parent's or a sibling's unconfined shell, which could still change it between the child's turns.

5. **A snapshot never merges.** A snapshot's child Workspace records its mode in the request of its child Workspace operation (`workspaceMode` in `ma_operation.request_json`), which is written once when the row is admitted and never rewritten. A request that names no mode is a worktree's, so worktree rows, including every row admitted before this change, read as `worktree` and their requests stay as they were. This needs no schema change. Every finish of a `snapshot` row is a discard.
   - **The relay** never asks a snapshot's merge and never holds a settlement for one. A completed snapshot run commits its result with no `workspace` receipt member, and no workspace line reaches the parent's model: the child changed nothing.
   - **The discard** is requested with the result commit and runs once the child is closed (I2 decision 4). The fail, stop and give-up arms and the close cascade discard as they do for `worktree`.
   - **The store** records a merge asked of a snapshot row as the discard it always is. The relay never asks one; the rule keeps a stray ask from parking a merge that can never run. A store from before this change records the merge an older relay asks of any ready row, so the scan also runs a merge recorded on a snapshot row as a discard.
   - **A row's mode is fixed.** A request naming another mode for an existing row is a conflict.
   - **An unknown mode fails closed.** A relay that meets a `workspaceMode` it does not serve settles the run `creation_failed`, never started, instead of creating it shared. The record contract admits only the three values, so this guards a future mode against an older relay.

6. **A snapshot child takes no messages while it runs.** It has no message lane (decision 4).
   - **Refused when sent.** The parent's `send_message` refuses a running snapshot child with a tool error that says so and suggests waiting for its result. This holds whether it is addressed by `task_id`, by member name or in a broadcast, where the line for that recipient says so. The refusal is in `sendToChild`, the one route every form takes, so no message is committed that the child could never receive.
   - **Why at the sender.** A message that reached a Session without a lane would keep the message relay retrying, and would hold the child's settlement (H4d-b decision 8) until the relay gave up.
   - **A completed snapshot child** is continued as usual. The continuation is a new snapshot run that prepares a new copy of the parent's tree as it then is.
   - **A team member cannot be a snapshot.** A member's instructions tell it to ask its leader with `send_message`, and its leader gives it work by message (H4e-b2). A snapshot has neither, and an undeclared call fails the member's Turn. So the Agent tool refuses `isolation: "snapshot"` with a `name` as an argument error before anything commits; a plain child launched from a team Session may still be a snapshot. The refusal suggests only the isolation the host serves.

7. **Glob rollout.** The read profile uses `glob`, which #13166 made an operator-enforced rollout: drain old workers and upgrade every provisioner. Child snapshots run only on the durable local-process Broker, which launches workers from the installed CLI. The operator turns snapshots on (decision 2) only after that rollout. An older worker answers `glob` with a tool error, never a write.

8. **Recovery reads the new profile.** `hosted-workspace-read/1` joins the saved-profile vocabulary, so creation, load and Workspace recovery all accept it.
   - A profile that recovery did not know would abort recovery of the whole shared storage. W1b puts the hosted files and Shell profiles inside that capture closure.
   - Storage migration still accepts only `files/1` Sessions, so a parent with a live snapshot child is refused, as one with any Shell child already is.
   - Committed read results of a Session with neither hooks nor MCP survive a replaced Runtime (decision 4). The G3 step-3 path (#14059) resumes a `results_ready` checkpoint without reacquiring the retired owner; it accepts the read profile beside `hosted-workspace-files/1`. A read profile's batch is always `read_file` and `glob`, the batch that path already resumes without file history.

9. **Serialized sharing needs no value of its own (final).** This confirms I1 decision 15.
   - **The guarantee.** The storage lease admits one holder at a time, and every writer of a storage takes it before writing: the parent, `shared` and `worktree` children, and child Workspace maintenance. A snapshot child's reads take it too. So no two children of one parent can hold the storage at once.
   - **The generation is the lease holder.** The barrier the 2026-10-04 framing asked for already exists. A value naming it would add no rule the lease does not enforce.
   - `workspaceMode` keeps its three values.

## Non-goals

- An OS-level read-only boundary, or a shell for snapshot children.
- More read tools (a content search, a directory listing): `read_file` and `glob` are what the worker serves today.
- Reading ignored files, or a snapshot of a directory outside a Git repository.
- A live read-only view of the parent's tree: the issue asks for a frozen one.
- Concurrency between a snapshot child and its parent: the lease still serializes their tool turns.
- Snapshot team members (decision 6).
- `workflow` children, which stay disabled.
- Any public contract change: the OpenAPI contract, routes and record bodies stay as they are. There is no schema change: the mode rides the child Workspace operation's request.

## Files affected

- **`packages/core/src/managed-runtime/managed-child-operations.ts`:** the admitted modes and the snapshot capability refusal.
- **`packages/cli/src/serve/`:**
  - `hosted-workspace-profiles.ts`: the read profile;
  - `hosted-workspace-tool-turn.ts`: the read declarations, the `isolation` value and its admission;
  - `hosted-tool-approval.ts`: pre-approving `glob` on the read profile;
  - `hosted-harness-session.ts`: the `childSnapshots` flag on create and load;
  - `hosted-child-agent-session.ts`: refusing messages to a running snapshot child, and the continuation's admission.
- **`packages/sdk-java/qwencode`:** `CreateHarnessSession` and `LoadHarnessSession` carry `childSnapshots`.
- **`packages/managed-agent-server`:**
  - `ManagedAgentProperties`: the switch;
  - `QwenHostedHarnessConnector`: the flag;
  - `ChildResultRelay`: prepare for both modes, discard a snapshot, and give it no receipt member;
  - `ChildWorkspaceStore` and `ChildWorkspaceService`: the mode in the operation's request, and a merge ask on a snapshot row recorded as a discard;
  - `ManagedAgentStore`: the read profile for a child bound to a snapshot row;
  - `WorkspaceToolProfiles`: the `READ` constant, the Java copy of the profile vocabulary.
- **Docs:** tests beside each, this design in both languages, and notes in the I1, I2 and G3 step-3 recovery designs.

## Validation

- **Admission** (`managed-child-operations.test.ts`): `snapshot` admitted only with both host flags; either flag alone refuses it, and the snapshot flag changes nothing for `shared` or `worktree`.
- **Agent tool** (`hosted-workspace-tool-turn.child-agent.test.ts`, 6 new cases, 1 updated; `hosted-workspace-tool-turn.team.test.ts`, 2 new cases; `hosted-child-wait-recovery.test.ts`, 3 new parameter rows):
  - the snapshot declarations, plain and team, are the worktree ones plus `snapshot`, only a host with both flags sees them (the snapshot flag alone leaves the team's plain), and only the team's says a member cannot be one;
  - a snapshot launch on a host without the snapshot flag, or without child Workspaces, is refused with its own sentence before any record, and neither sentence suggests a child that can write;
  - a launch on a capable host records `snapshot`; any other `isolation` is an argument error naming only what the host serves;
  - a launch or a member naming no isolation still runs `shared` on a capable host;
  - a snapshot member is refused before anything commits while a plain snapshot child is admitted;
  - a foreground snapshot answer, a started snapshot child's failure, and a snapshot orphan folded at recovery carry no `[child workspace]` line;
  - a completed snapshot child is continued as a snapshot through both forms of `send_message`, after a send to it while it ran was refused.
- **Read profile** (`hosted-workspace-tool-turn.test.ts`, 7 new cases, 1 updated; `hosted-workspace-tool-turn.child-agent.test.ts`; `hosted-tool-approval.test.ts`; `hosted-workspace-profiles.test.ts`):
  - it declares `read_file` and `glob` on any lane, and nothing else even on a turn with a Shell lane and depth-0 orchestration;
  - both tools dispatch to the Broker;
  - `write_file`, `edit`, `run_shell_command`, `monitor`, `agent` and `send_message` are each refused before the Broker is acquired;
  - both read tools are pre-approved under `default` and `auto-edit`, and `glob` is pre-approved only on the `/2` and read profiles.
- **Messages** (`hosted-session-message-session.test.ts`): a snapshot child is refused while it runs, before and after it attaches, with nothing committed, while a running worktree child still takes a message; once completed, a snapshot is continued only where snapshots are served, as a `snapshot` run; a closing Session's refusal promises no continuation.
- **Host flag and recovery** (`hosted-harness-session.test.ts`, 3 new cases; `workspace-recovery-session.test.ts`): `snapshot` advertised only while a create or load restates both flags (not for the snapshot flag alone or for `"true"` as text); a read-profile Session is created and declares its two tools, and one whose agent definition publishes Skills takes no skill catalog; recovery accepts the read profile and still refuses it with a capture size.
- **Replaced Runtime** (`hosted-recovery.test.ts`, 2 new cases): a read-profile child whose `read_file` result committed before its Runtime was replaced resumes the saved model request without rerunning the tool, releases the original owner, and refuses a new tool call in that Turn.
- **Relay** (`ChildResultRelayTest`, 6 new cases):
  - a snapshot run prepares its copy with its own mode and creates its child isolated;
  - a completed snapshot commits at once with no `workspace` member and asks only its discard;
  - its completed task asks no merge while messages run;
  - the over-bound, stop and give-up arms settle it at once, asking the discard and never a merge;
  - a mode the relay does not serve settles never started, creating nothing, while a run naming `shared` creates its child shared.
- **Child Workspace state machine** (`ChildWorkspaceServiceTest`, 4 new cases on H2 with real repositories):
  - the snapshot copy carries the parent's uncommitted and untracked files, not its ignored ones;
  - its child Session gets exactly `hosted-workspace-read/1` and the parent's approval mode;
  - a merge asked of it is recorded as a discard, a file written into the copy never reaches the parent, and the row ends `discarded` with no pins left;
  - a merge recorded on it as asked, as an older relay's store records one, still runs as a discard, and a file written into the copy never reaches the parent;
  - a worktree's request names no mode, and its row reads as a worktree that merges and keeps its parent's profile;
  - a run's mode is fixed.
- **Control-plane plumbing** (`ManagedAgentPropertiesTest`, `QwenHostedHarnessConnectorTest`, `HostedHarnessClientTest`): the switch is off by default, refused without child Workspaces and boots beside a valid child-Workspaces configuration; `childSnapshots` rides create, load, recovery, lifecycle settle and the message-stop load only with the switch on, through every request copy, and never without `childWorkspaces`.
- **Lanes**, on `main` at `415925cbda`:
  - the CI-identical MariaDB lane (`-Pmysql-integration clean verify checkstyle:check`, with CI's 64 MiB packet budget): 2762 unit and 548 integration tests, Checkstyle and SpotBugs clean, plus `qwencode`'s `HostedHarnessClientTest`;
  - TypeScript in a clean `pnpm` worktree: `tsc` for core and CLI, ESLint and Prettier on every touched file, the core `managed-runtime` suite (3402 tests) and the CLI `serve` suite (14828 tests).
  - The failures there are not this change's; each fails identically on `main` on the same host:
    - two Java classes, `WorkspaceCsiNativeActivationGateTest` (16) and `ManagedExtensionRecordStoreTest` (4);
    - three `serve` tests that expect a write to fail, which it does not as root.
- **After merging `main` at `8bd79c9192`** (which moved the module to `packages/managed-agent-server`):
  - the same lane ran 3870 unit and 673 integration tests, Checkstyle and SpotBugs clean. Its one failure, `SessionRowLockOrderTest` (the lock-order pin for `Row.snapshot/0`), is fixed here; with the fix, the unit suite runs 3871 tests and none fail;
  - the CLI `serve` suite ran 15018 tests. One timing test in `managed-runtime-tool-executor.test.ts` failed under load and passed alone three times.
- **Mutation checks**: 47 mutants, each disabling one guard (24 Java, 23 TypeScript), all red; the two review rounds added 6 and 11 more, also all red. One more, dropping the snapshot flag from the team form of `send_message`, is equivalent (that form reaches only members, never snapshots) and is not counted.

## Acceptance criteria

- **Cannot write.** A `snapshot` child cannot write: its declared tools are `read_file` and `glob`, and any other call is refused before it reaches the Workspace.
- **Frozen.** It reads the parent's tree as it was at launch, and its copy is discarded however it ends; nothing of it ever merges.
- **Gated.** A host without the snapshot switch refuses `isolation: "snapshot"` before anything commits.
- **Messages.** A running snapshot child is never sent a message it cannot receive.
- **Serialization.** The serialization decision records why the lease already guarantees one holder at a time.
- **No regressions.** `shared` and `worktree` children behave exactly as before.

## Open questions

1. **The lease for reads.** Should a snapshot child's reads skip the storage lease? It reads a copy only the control plane writes. Skipping would let it run beside its parent, but the lease now also covers child Workspace maintenance of that copy. Left for a later request.
2. **More read tools.** A content search or a directory listing would make snapshot children more useful. Each needs a worker tool and a Broker payload shape.
