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

`bin/qwen-managed-agent-upgrade <phase>` is a Node.js script beside the bootstrap. It runs as root from the extracted new distribution. It reads the two units through `systemctl show`: the server unit's `ExecStart` locates the installed release, and the `EnvironmentFiles` and `Environment` properties supply the settings. It reads environment files with systemd's own grammar, the state machine in systemd's `env-file.c`, so a value such as a password reaches `mysqldump` exactly as the service receives it. A differential run of 1579 random files against systemd 257 found no difference.

- **`check`**
  - Requires: nothing.
  - Does: prints one row per input and a plan, and exits 1 on any FAIL.
- **`stop`**
  - Requires: `check` has no FAIL, unless the new release is already installed. Then `stop` is how a failed `start` is undone, and the comparison it guards has already been made.
  - Does:
    1. Stops the control plane.
    2. Runs `systemctl kill --kill-whom=all` when its cgroup still holds processes, and waits until the cgroup is empty. It reads the cgroup systemd names in the unified hierarchy, or on cgroup v1 in systemd's own, and refuses when it can read neither the hierarchy nor the cgroup: an unreadable cgroup is no proof that no worker runs.
    3. Stops the Harness.
    4. Says why the control plane shows as `failed` when it does, as a unit installed before `SuccessExitStatus=143` does after every stop.
- **`backup`**
  - Requires: both units stopped and the server cgroup empty; the new release not yet installed; the `backup-tools` and `runtime-state` rows have no FAIL; `--to` new, or empty and root's own.
  - Does:
    - writes `database.sql` from `mysqldump`, with the credentials in an option file in a temporary directory outside the backup. `--defaults-file` makes it the only option file, so a later one such as `~/.my.cnf` cannot replace them;
    - writes `runtime-state.tar`, `configuration.tar` of the configuration outside the release, and `release-config.tar` of the configuration in the release by its path there. A configuration file that is a link goes in with the file it names;
    - writes `backup.json` last, recording the other files;
    - removes what it wrote when a step fails or a signal ends it.
- **`install`**
  - Requires: both units stopped; a backup that still describes the deployment; `check` has no FAIL.
  - Does:
    1. Removes what an install killed earlier left: partial copies, `.upgrade-<8 hex digits>` links beside the distribution path, and `.tmp-` operator files in the release it will use. `check` lists them in the `layout` row.
    2. Copies the release to `<distribution>-releases/<version>`, verifies the copy and makes the files `SHA256SUMS` lists readable by every account, removing the copy when a step fails. An existing directory there is used only when its `SHA256SUMS` is the new distribution's and its files match it.
    3. Copies operator files from the installed `config/`.
    4. Replaces the distribution link with one `rename`. The first run instead moves the installed directory into the releases directory and puts a link in its place, and moves the directory back when the second `rename` fails. When that move back fails too, it keeps the link and names both `mv -T` commands.
- **`start`**
  - Requires: the new release installed; the server unit stopped; the Broker settings edited.
  - Does:
    1. Starts the Harness, or restarts one an earlier `start` left running, and waits for its port.
    2. Runs the installed launcher's `--check` through `systemd-run`, with the unit's user, working directory and environment. The unit's `Environment=` assignments go in a `0600` environment file rather than on the `systemd-run` command line, which every local user can read.
    3. Only when that passes, starts the control plane and waits for `/actuator/health` to report `UP`. One probe waits at most 5 seconds. A unit that exits is stopped and reported: one that shows `failed`, waits in `auto-restart`, or has a non-zero `NRestarts`, since the shipped units' `Restart=on-failure` restarts an exited process rather than leaving it failed. This holds for a unit the restart would bring up: an exit during the start that runs the new release's migrations is read in the journal before the release is trusted, not passed on a retry. Probing health before the unit would not change that, since the poll runs every second and `RestartSec=5s` keeps an exited unit in `auto-restart` for five. One still not healthy at `--timeout` keeps running, and the refusal names `verify` and `stop`.
- **`verify`**
  - Requires: both units running.
  - Does:
    - runs `--check --online` the same way;
    - reads the actuator, with one probe that may take all of `--timeout`;
    - with `--tenant`, reads the most recent Session and its Items, before `--turn` creates one, as the `--actor` it is given through the server's trusted actor header;
    - with `--turn`, runs one Turn in a new Session, which calls the model, polling past `5xx` answers and dropped connections;
    - skips both API reads when the configuration the server resolves sets signed authentication, with a `turn` row that says so when `--turn` was given.
    - No request outlasts `--timeout`.

The phases keep no state file. Each re-reads the units, files and links, so a phase interrupted by a crash is simply run again. `SIGINT`, `SIGTERM` and `SIGHUP` remove the temporary files and the partial backup or copy a phase would remove on failure, which Node otherwise skips by exiting without running `finally` blocks. One that cannot be removed is named, and the rest still go before the command exits as the signal would have. Running `stop` again changes nothing it already did, and `install` reuses a copy of the same build. Once the rename has installed the release, `install` run again says so and names `start`, before it reads the backup: a new backup taken then would record the new release as the one to return to. The one window a re-run cannot close is a crash between the first install's two renames. The distribution path is then missing and the new link sits beside it as `<distribution>.upgrade-<suffix>`. Every phase reports that state and names the `mv -T` that finishes the install.

### Check rows

| Row             | FAIL                                                                                                                                                                    | WARN                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `distribution`  | a file differs from `SHA256SUMS`                                                                                                                                        |                                                                                                      |
| `deployment`    | a unit is not loaded, the server does not start a distribution launcher, the new manifest is unreadable, or an install was interrupted                                  |                                                                                                      |
| `version`       | same or older release                                                                                                                                                   |                                                                                                      |
| `database`      | a script the installed database ran was changed or removed; a repeatable script was removed; a new versioned script does not sort after the newest one the database ran | scripts to apply, a changed repeatable one included; the jars cannot be read                         |
| `java`, `node`  | below the manifest's minimum, or not found                                                                                                                              | a range the command cannot read                                                                      |
| `qwen-code`     |                                                                                                                                                                         | the Harness runs another version than the manifest; a newer one may stay if the operator tested it   |
| `harness-env`   |                                                                                                                                                                         | `QWEN_HOSTED_HARNESS_BROKER_ARGS`, or the Broker token set twice                                     |
| `config`        | a non-file in the installed `config/`                                                                                                                                   |                                                                                                      |
| `unit-files`    |                                                                                                                                                                         | a unit template changed between the releases                                                         |
| `layout`        | the releases directory is inside either distribution, or on another file system than a directory install moves                                                          |                                                                                                      |
| `backup-tools`  | the `--mysqldump` client is not installed, or the datasource is not a single-host MySQL URL                                                                             | (SKIP with `--skip-database`)                                                                        |
| `runtime-state` | the server's configuration cannot be resolved and `--runtime-state` is absent; `--runtime-state` is not a directory                                                     | the resolved directory does not exist (SKIP when none is configured, or with `--runtime-state none`) |

`check` takes the options of the later phases and prints them into its plan, so the rows describe the run the operator will make. `stop` and `install` repeat all rows above `backup-tools`; `backup` repeats the last two.

The `database` row reads the Flyway scripts from both server jars: the manifest's control-plane component, entries `BOOT-INF/classes/db/**/` named as Flyway names versioned, undo and repeatable scripts. The `V`, `U` and `R` prefixes are case-sensitive and the `.sql` suffix is not, as in Flyway. A short zip reader follows the central directory and inflates the entries with `zlib`, so releases that predate this change are compared as well. Script contents, not the manifests' version strings, decide the row: a changed script fails even when both manifests name version `1`. Flyway runs a changed repeatable script again, so that is a WARN, while a removed one fails validation. With `outOfOrder` off, as the server keeps it, Flyway also refuses a new versioned script whose version does not sort after the newest one the database ran, comparing the versions part by part. A jar in which the reader finds no script is unreadable rather than unchanged, since no server ships without its schema.

`harness-env` warns rather than fails. The backup has to keep the files the old release reads, so the edits happen after `backup`; `start` refuses until they are made.

### Runtime state directory

Spring resolves `qwen.managed-agent.runtime-broker.state-directory` from many places: the variable the server's `application.yml` maps, `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`; every configuration file in Spring's default locations and the launcher's `SPRING_CONFIG_ADDITIONAL_LOCATION`; the files an import or a profile brings in; `SPRING_APPLICATION_JSON`; system properties; command-line arguments; and every relaxed spelling of the property. Earlier rounds of this command read that list itself and refused on what it recognized, and each round found a source it missed. Its configuration resolution has no closed list, so the command no longer reads it.

Instead, `check` and `backup` ask the server. The server jar has a main class, `ResolvedConfiguration`, that prepares the environment the way `SpringApplication` does before it creates a context: the arguments, the process environment and every environment post-processor on the class path, which load the configuration files, imports and profiles. It then binds the server's properties and prints the state directory, made absolute in the working directory as the server does, where it came from, the auth mode and the trusted actor header, on one line after a fixed prefix. It starts no context, logs nothing and opens no connection.

The command runs it through `systemd-run` as the control-plane unit runs the server: the unit's account, working directory, environment files and `Environment=` assignments, the `java` on the unit's `PATH`, and the launcher's one default, `config/application.yml` when `SPRING_CONFIG_ADDITIONAL_LOCATION` is unset or empty. It runs this release's jar, copied where the service account can read it wherever the archive was extracted, through `PropertiesLauncher` with `loader.main`, so an older jar without the class fails rather than starting a server. `verify`, which runs after `install`, uses the installed jar and reads the auth mode from the same output. The admin launcher runs the same class as `resolved-configuration`, for the manual procedure on other layouts.

Two cases stay with the operator. The jar can fail to resolve the configuration, as when an import names a missing file, which the server would refuse too. And `systemctl show` prints `ExecStart` arguments joined by spaces, unquoted, so the command cannot pass on arguments the unit gives the launcher. In either case `backup` refuses until `--runtime-state <directory>` names the directory, or `--runtime-state none` declares a deployment that keeps no Runtime state. A backup without the Runtime state the database refers to cannot be restored consistently, so a backup that silently left it out would be worse than a refusal. When the configuration names no directory, as on a deployment without the tool path, `backup` archives none and prints that.

### Backup freshness

`backup.json` records these facts:

- the installed and target versions;
- where `install` leaves the previous release;
- the boot ID;
- the server unit's `ActiveEnterTimestampMonotonic` and `InactiveEnterTimestampMonotonic`;
- the database the dump is of: host, port and name, without credentials;
- each file's size and SHA-256.

`install` refuses the backup if any of these differs. In particular, a reboot changes the boot ID, a start since the backup changes either timestamp, and an edited `SPRING_DATASOURCE_URL` names another database than the one dumped. The record also names the distribution path and the units, so the guide's rollback reads every path from it.

### Preflight changes

- The `database` row compares versions in Flyway order:
  - an older schema warns that the first start migrates it;
  - a newer schema fails.
- At the manifest's version, the `database` row runs `ManagedSchema.validate`, the same validation the server runs at startup, and fails when the database does not match.

### Unit template

The control-plane unit adds `SuccessExitStatus=143`. `check` reports the changed template as a WARN, and the operator carries the change over to the installed unit. Until then, the stop the upgrade itself makes leaves the unit `failed`, so `stop` says so and names `systemctl reset-failed` for after the change.

## Compatibility and risks

- **Distribution layout.** The distribution gains two files, `bin/qwen-managed-agent-upgrade` and its `.mjs` script. The first `install` turns `/opt/qwen-managed-agent` into a link, and the units keep their paths.
- **`--check` results.**
  - A newer database still fails. An older one now warns instead of failing.
  - A database at the manifest's version that the server would refuse now fails.
- **Old releases.** The command reads releases that predate it: their manifests, their server jars and their unit templates. It does not run any of their code; to resolve the configuration it runs this release's jar.
- **What the command does not cover.** `backup` covers the database, the Runtime state and the configuration. It does not back up the Workspace, which the upgrade leaves in place.

## Validation plan

- **Unit tests (`scripts/tests/managed-agent-upgrade.test.mjs`).** They use a fake `systemctl`, `systemd-run` and API on a virtual clock, with real files, `tar` and zip archives. They cover:
  - parsing of environment files, `systemctl show` output, versions, JDBC URLs and the jar's scripts;
  - each check row;
  - every phase's refusals and its steps.
- **Environment files.** 1579 random files read back through `systemd-run` on systemd 257, with no difference from the command's reader.
- **Mutation testing.** 87 mutants of the script's decisions, 5 of the preflight changes and 8 of `ResolvedConfiguration` and the auth mode it reads; the follow-up added 33 for its own changes and 9 for its review.
- **Preflight unit tests:**
  - Flyway ordering;
  - the validation hook;
  - the validation `databaseCheck` runs, on an H2 database Flyway migrated.
- **`ResolvedConfiguration` unit tests**, through Spring's own preparation: an import in the launcher's file, a flow mapping with sibling keys, a merge key, a profile file beside a directory location, a properties file chosen by `SPRING_CONFIG_NAME`, every environment spelling, `SPRING_APPLICATION_JSON`, a relative directory, the auth mode and actor header, a missing import, and the printed line.
- **End to end on a real host** (systemd 257, MySQL 8.4, the real Hosted Harness with a fake model). The old release was installed the way `systemd/README.md` describes, with a stand-in worker left in the server cgroup.
  - **Compatible upgrade:** every phase, plus these checks:
    - the refusals for running and out-of-order phases;
    - a restore drill into a fresh MySQL;
    - `verify --turn`;
    - a database password with a backslash, which the previous reader dropped;
    - `stop` after `install`;
    - the documented rollback, every path read from `backup.json`;
    - a Runtime state directory that only a file imported through a flow mapping names, archived by `backup` and restored by the rollback;
    - `check` against five other sources of that directory and an import of a missing file, with this command and its previous version;
    - `Environment=` kept off the `systemd-run` command line, sampled with `ps` during `verify`;
    - the notice `stop` prints for a unit that ends `failed`, and a second `install`.
  - **Baseline rewritten in place:** `check` fails and `stop` refuses.
  - **Interrupted first install:** `SIGKILL` at each of ten filesystem steps, from the copy to the last `rename`. Each run of `install` that follows, after the `mv -T` that `check` names where it names one, leaves the layout of an install that was not interrupted, and the control plane then starts and passes `verify`.
  - **Signals:** `SIGTERM` to the command and `SIGINT` to its process group during the dump, and `SIGTERM` during the copy, leave no option file, backup directory or partial copy.
  - **Option files:** with root's `~/.my.cnf` naming another account, `--defaults-extra-file` connects as that account and is refused; `--defaults-file` connects as the service account.
  - **A control plane killed after it starts:** the previous module waits the whole `--timeout` and reports a slow start while systemd restarts the unit; this one stops it within seconds. The next `start` restarts the Harness the first one left running.
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
