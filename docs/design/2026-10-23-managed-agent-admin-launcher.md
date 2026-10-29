# Reference Distribution Admin Launcher

[English](2026-10-23-managed-agent-admin-launcher.md) | [简体中文](2026-10-23-managed-agent-admin-launcher.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

The server has twelve offline maintenance entry points, such as Workspace storage registration, Workspace migration, recovery, and the CSI commands. Only one of them, the Hosted Shell recovery command, has a launcher in the reference distribution. The documentation runs the others as `java -Dloader.main=<class> -cp target/<jar> org.springframework.boot.loader.launch.PropertiesLauncher …`, from a module build.

That form does not work for an operator who installed the reference distribution:

- Some examples name a classified jar, such as `-csi-runtime.jar`, which the distribution does not ship.
- They name paths under `target/`, which exist only in a source checkout.
- The operator has to copy a fully qualified class name from the README.

## Goals

- One launcher in the distribution runs every maintenance entry point by a short command name.
- It needs no jar beyond the server jar the distribution already ships.
- It lists its commands, and loads the distribution's configuration as the other launchers do.
- A renamed or removed entry point fails packaging instead of shipping a command that cannot start.
- The documentation shows the distribution form next to the module-build form.

## Non-goals

- Changing any entry point's arguments or behaviour.
- Removing the classified jars from the module build, or the operator-recovery jar and launcher from the distribution.
- Making a command safe to run online. Each remains an offline procedure with its own preconditions.

## Design

### Commands

`scripts/package-managed-agent-reference.mjs` exports `ADMIN_COMMANDS`: each entry holds a command name, the entry point's class and a one-line summary.

| Command                  | Entry point                                    |
| ------------------------ | ---------------------------------------------- |
| `storage-registration`   | `persistence.WorkspaceStorageRegistrationMain` |
| `workspace-recovery`     | `persistence.WorkspaceRecoveryMain`            |
| `workspace-migration`    | `workspace.runtime.WorkspaceMigrationMain`     |
| `maintenance-recovery`   | `persistence.WorkspaceMaintenanceRecoveryMain` |
| `operator-recovery`      | `workspace.runtime.WorkspaceRecoveryCommand`   |
| `csi-registration`       | `persistence.WorkspaceCsiRegistrationMain`     |
| `csi-protection`         | `workspace.runtime.WorkspaceCsiProtectionMain` |
| `csi-session`            | `persistence.WorkspaceCsiSessionMain`          |
| `csi-runtime`            | `persistence.WorkspaceCsiRuntimeMain`          |
| `csi-retirement`         | `persistence.WorkspaceCsiRetirementMain`       |
| `csi-worker-ack`         | `persistence.WorkspaceCsiWorkerAckMain`        |
| `resident-retirement`    | `persistence.ResidentWorkspaceRetirementMain`  |
| `resolved-configuration` | `preflight.ResolvedConfiguration`              |

All classes are under `com.alibaba.qwen.code.managedagent`.

### Launcher

The packager writes `bin/qwen-managed-agent-admin`, a POSIX shell script.

- Like the server launcher, it sets `SPRING_CONFIG_ADDITIONAL_LOCATION` to `config/application.yml` when that file exists and the variable is unset.
- Without a command, or with `help`, it prints the commands and their summaries and exits 0, without starting Java.
- An unknown command prints the same list to standard error and exits 2.
- A known command runs `java -Dloader.main=<class> -cp lib/<server jar> org.springframework.boot.loader.launch.PropertiesLauncher <arguments>`.
- It maps no environment. Each entry point keeps reading its own credentials, which the guide lists: `W1_JDBC_*` for the Workspace commands, `K2_JDBC_*` for the CSI commands, and the control plane's Spring datasource, `SPRING_DATASOURCE_*`, for `operator-recovery` and `resident-retirement`, which start the server's Spring configuration.

Every classified jar in the module build is the same application repackaged with another main class, so the executable server jar, which the distribution ships as `lib/<server jar>`, already contains every entry point.

### Packaging check

Before writing the launcher, the packager reads each class's source under `packages/managed-agent-server/src/main/java`, and fails when the file is missing or has no `public static void main(String`.

### Documentation

- The deployment guide gains a "Maintenance commands" section.
- The server README's storage-registration and Workspace-migration sections, and the K2 resident README's protection and retirement commands, show `bin/qwen-managed-agent-admin` first.
- The module-build commands in the K2 README now use the executable server jar, `-exec.jar`, which carries every entry point, instead of the `-csi-runtime` jar.
- The reference distribution design adds the launcher to the bundle layout.

## Compatibility and risks

- The distribution gains one launcher and no jar. Every existing launcher, jar and documented module-build command keeps working.
- The command names become part of the distribution's operator interface, so later renames need a compatibility note.
- `PropertiesLauncher` from the server jar is the form the server README already documents for storage registration, so no new launch path is introduced.

## Validation plan

- Packaging tests:
  - every command maps to its class, with a fake `java` on `PATH`, and passes the arguments through;
  - help lists every command and its summary and starts no Java;
  - an unknown command exits 2;
  - packaging fails for a missing class and for a class without a main method;
  - every class exists in the real source tree with a main method, and the names are unique.
- End to end with the packaged distribution and the real server jar:
  - every command without arguments reaches its own entry point, shown by that entry point's usage error;
  - `storage-registration inspect` reads a migrated MySQL database through the distribution configuration.

## Acceptance criteria

- An operator runs every maintenance entry point from the reference distribution as `bin/qwen-managed-agent-admin <command>`.
- Packaging fails when an entry point is renamed or removed.

## Follow-up work

- Drop the classified jars once the module-build documentation no longer names them.
