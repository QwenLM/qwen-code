# Reference Distribution Upgrade Command

[English](2026-10-25-managed-agent-upgrade-command.md) | [简体中文](2026-10-25-managed-agent-upgrade-command.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

The deployment guide describes the upgrade as seven manual steps. On the systemd layout, an operator has to work out several things alone:

- which files make up the deployment;
- how to reap the Runtime workers that `KillMode=process` leaves behind;
- how to back up MySQL without putting the password on a command line;
- how to switch releases so that a rollback is one step.

Three other problems show up only on a real host:

- **Rewritten schema baseline.** Until the first formal release, a release may rewrite its Flyway baseline in place. `ManagedSchema` says so: "Keep V1 until the first formal release". Two releases whose manifests both name schema version `1` can therefore disagree on the schema. The newer server refuses the older database at startup. An operator learns this only after stopping, backing up and installing, and the service then restarts in a loop.
- **Preflight passes a database the server refuses.** The `--check` `database` row compares version strings only. It passes a database the server will refuse, and fails an older database that the first start would migrate.
- **Stopped unit shows as failed.** The JVM exits with status 143 after a clean `SIGTERM` shutdown, and the control-plane unit does not count that as success. Every stop therefore leaves the unit failed.

## Goals

- One command in the new distribution runs the upgrade in phases that an operator can follow, stop and resume.
- Each phase re-reads the deployment and refuses unless the previous phase left it as expected.
- The command finds an upgrade the new release cannot serve before anything stops.
- A backup holds what a rollback needs, and the previous release stays installed.
- `--check` agrees with the server on the schema.

## Non-goals

- Layouts other than the systemd one. The guide keeps the manual steps for them.
- Stopping ingress, installing Qwen Code, or editing environment or unit files. The command prints these steps where they fall.
- Rolling back automatically. The guide documents the rollback.
- Changing the in-place baseline policy before the first formal release.

## Design

### Phases

`bin/qwen-managed-agent-upgrade <phase>` is a Node.js script beside the bootstrap. It runs as root from the extracted new distribution. It reads the two units through `systemctl show`: the server unit's `ExecStart` locates the installed release, and the `EnvironmentFiles` and `Environment` properties supply the settings.

- **`check`**
  - Requires: nothing.
  - Does: prints one row per input and a plan, and exits 1 on any FAIL.
- **`stop`**
  - Requires: `check` has no FAIL.
  - Does:
    1. Stops the control plane.
    2. Runs `systemctl kill --kill-whom=all` when its cgroup still holds processes, and waits until the cgroup is empty.
    3. Stops the Harness.
- **`backup`**
  - Requires: both units stopped and the server cgroup empty.
  - Does:
    - writes `database.sql` from `mysqldump`, with the credentials in a temporary option file;
    - writes `runtime-state.tar` and `configuration.tar`;
    - writes `backup.json` last, recording the other files;
    - removes what it wrote when a step fails.
- **`install`**
  - Requires: both units stopped; a backup that still describes the deployment; `check` has no FAIL.
  - Does:
    1. Copies the release to `<distribution>-releases/<version>` and verifies the copy.
    2. Copies operator files from the installed `config/`.
    3. Replaces the distribution link with one `rename`. The first run instead moves the installed directory into the releases directory and puts a link in its place.
- **`start`**
  - Requires: the new release installed; the server unit stopped; the Broker settings edited.
  - Does:
    1. Starts the Harness and waits for its port.
    2. Runs the installed launcher's `--check` through `systemd-run`, with the unit's user, working directory and environment.
    3. Only when that passes, starts the control plane and waits for `/actuator/health` to report `UP`.
- **`verify`**
  - Requires: both units running.
  - Does:
    - runs `--check --online` the same way;
    - reads the actuator;
    - with `--tenant`, reads a Session and its Items;
    - with `--turn`, runs one Turn in a new Session, which calls the model.

The phases keep no state file. Each re-reads the units, files and links, so a phase interrupted by a crash is simply run again. Running `stop` again changes nothing it already did, and `install` reuses a copy whose checksums match.

### Check rows

| Row            | FAIL                                                                                                        | WARN                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `distribution` | a file differs from `SHA256SUMS`                                                                            |                                                                  |
| `deployment`   | a unit is not loaded, or the server does not start a distribution launcher                                  |                                                                  |
| `version`      | same or older release                                                                                       |                                                                  |
| `database`     | a script the installed database ran was changed or removed                                                  | new scripts to apply; the jars cannot be read                    |
| `java`, `node` | below the manifest's minimum, or not found                                                                  | a range the command cannot read                                  |
| `qwen-code`    |                                                                                                             | the Harness runs another version than the manifest               |
| `harness-env`  |                                                                                                             | `QWEN_HOSTED_HARNESS_BROKER_ARGS`, or the Broker token set twice |
| `config`       | a non-file in the installed `config/`                                                                       |                                                                  |
| `unit-files`   |                                                                                                             | a unit template changed between the releases                     |
| `layout`       | the releases directory is inside the distribution, or on another file system than a directory install moves |                                                                  |
| `backup-tools` |                                                                                                             | no `mysqldump` on `PATH`                                         |

The `database` row reads the Flyway scripts from both server jars: the manifest's control-plane component, entries `BOOT-INF/classes/db/**/V*__*.sql` or `U*__*.sql`. A short zip reader follows the central directory and inflates the entries with `zlib`, so releases that predate this change are compared as well. Script contents, not the manifests' version strings, decide the row: a changed script fails even when both manifests name version `1`.

`harness-env` warns rather than fails. The backup has to keep the files the old release reads, so the edits happen after `backup`; `start` refuses until they are made.

### Backup freshness

`backup.json` records five things:

- the installed and target versions;
- the boot ID;
- the server unit's `ActiveEnterTimestampMonotonic` and `InactiveEnterTimestampMonotonic`;
- each file's size and SHA-256.

`install` refuses the backup if any of these differs. In particular, a reboot changes the boot ID, and a start since the backup changes either timestamp.

### Preflight changes

- The `database` row compares versions in Flyway order:
  - an older schema warns that the first start migrates it;
  - a newer schema fails.
- At the manifest's version, the `database` row runs `ManagedSchema.validate`, the same validation the server runs at startup, and fails when the database does not match.

### Unit template

The control-plane unit adds `SuccessExitStatus=143`. `check` reports the changed template as a WARN, and the operator carries the change over to the installed unit.

## Compatibility and risks

- **Distribution layout.** The distribution gains two files, `bin/qwen-managed-agent-upgrade` and its `.mjs` script. The first `install` turns `/opt/qwen-managed-agent` into a link, and the units keep their paths.
- **`--check` results.**
  - A newer database still fails. An older one now warns instead of failing.
  - A database at the manifest's version that the server would refuse now fails.
- **Old releases.** The command reads releases that predate it: their manifests, their server jars and their unit templates. It does not run any of their code.
- **What the command does not cover.** `backup` covers the database, the Runtime state and the configuration. It does not back up the Workspace, which the upgrade leaves in place.

## Validation plan

- **Unit tests (`scripts/tests/managed-agent-upgrade.test.mjs`).** They use a fake `systemctl`, `systemd-run` and API on a virtual clock, with real files, `tar` and zip archives. They cover:
  - parsing of environment files, `systemctl show` output, versions, JDBC URLs and the jar's scripts;
  - each check row;
  - every phase's refusals and its steps.
- **Mutation testing.** 21 mutants of the script's decisions and 4 of the preflight changes.
- **Preflight unit tests:**
  - Flyway ordering;
  - the validation hook.
- **End to end on a real host** (systemd 257, MySQL 8.4, the real Hosted Harness with a fake model). The old release was installed the way `systemd/README.md` describes, with a stand-in worker left in the server cgroup.
  - **Compatible upgrade:** every phase, plus these checks:
    - the refusals for running and out-of-order phases;
    - a restore drill into a fresh MySQL;
    - `verify --turn`;
    - the documented rollback.
  - **Baseline rewritten in place:** `check` fails and `stop` refuses.
  - **Preflight A/B on the same host state:**
    - the release before this change passes a database the server refuses;
    - this release fails it.

## Acceptance criteria

- An operator upgrades a systemd deployment with six commands and the manual steps that `check` prints.
- An upgrade the new release cannot serve fails at `check`, before anything stops.
- A rollback restores the database, Runtime state and configuration from one backup, and returns to a release that is still installed.

## Follow-up work

- Once the first formal release freezes the baseline, ship schema changes as new Flyway versions. The `database` row then turns these upgrades into WARNs.
- Remove releases the operator no longer needs, keeping the installed release and the one before it.
