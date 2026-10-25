# Bootstrap Service Account and MySQL Setup

[English](2026-10-23-managed-agent-bootstrap-service-account.md) | [简体中文](2026-10-23-managed-agent-bootstrap-service-account.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

`bin/qwen-managed-agent-bootstrap` writes `harness.env`, `server.env` and `application.yml` owned by whoever runs it, all at mode `0600`. The systemd layout needs other owners: the service account must own `harness.env` and `application.yml`, and `server.env` is `0640 root:qwen-managed-agent`. An operator who runs the bootstrap as root, as the `/etc` layout requires, must then fix three owners and modes by hand. If they miss one, the server refuses to start because it cannot read the file.

The database is also left to the operator. The bootstrap writes `SPRING_DATASOURCE_PASSWORD=replace-me`. The statements that create the database, the account and the `performance_schema` grant appear only in a comment in the server README's development section. That comment also carries the `skip-name-resolve` trap: an account at `localhost` alone never matches a TCP client from `127.0.0.1`.

Finally, preflight checks whether the configuration and credentials files are readable as the process running `--check`. Run as root, every file is readable, so the `config` and `credentials` rows pass a file the service account cannot read. The server then refuses at startup.

## Goals

- One bootstrap command produces the systemd layout's files with their final owners and modes.
- The bootstrap generates the database password and the SQL that creates the database and account.
- Preflight checks file access as the service account, whoever runs it.
- No secret is printed.

## Non-goals

- Creating the service account, or running SQL against MySQL. The bootstrap only writes files.
- Checking ACLs, SELinux labels or capabilities. File access is judged from owners and modes.
- Checking directory access for the Workspace and Runtime state as the service account. The existing rows still check them as the process running preflight.

## Design

### `--service-user`

`--service-user NAME` requires the bootstrap to run as root. It refuses otherwise. The name must be a portable user name (`[a-z_][a-z0-9_-]{0,31}`), because it is written unquoted into `server.env`. The bootstrap reads the account's uid, primary gid and groups with `id`, and refuses an account that does not exist.

With the option:

| File                                         | Owner                     | Mode   |
| -------------------------------------------- | ------------------------- | ------ |
| `harness.env`                                | account : account's group | `0600` |
| `application.yml`                            | account : account's group | `0600` |
| `server.env`                                 | root : account's group    | `0640` |
| `mysql-setup.sql`                            | root : root               | `0600` |
| the directory, when the bootstrap creates it | root : account's group    | `0750` |

Each file is written to a temporary name, given its owner and mode, then renamed, so it never appears with another owner. An existing directory is left unchanged, since it may be shared, such as `/etc`. The bootstrap then checks that the account can enter every directory the kernel passes through to reach the directory, and the directory itself. It walks the path as the kernel resolves it, so a symbolic link adds the directories along its target, while the directory that holds the link stays on the list. It applies the owner bits to the owner, then the group bits to members, then the others bits, as the kernel does. If any directory blocks the account, the bootstrap writes no file and names that directory. A directory it has just created stays, already with its final owner and mode, so a rerun after the fix uses it.

`server.env` records the account as `QWEN_MANAGED_AGENT_SERVICE_USER`. Without the option, the bootstrap behaves as before, except for the database password and the SQL file.

### MySQL setup

The bootstrap generates a random 64-character hex database password and writes it to `server.env` as `SPRING_DATASOURCE_PASSWORD`. It also writes `mysql-setup.sql` with the same password:

- `CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
- `CREATE USER` for `'qwen'@'localhost'` and `'qwen'@'127.0.0.1'`;
- `GRANT ALL ON qwen_managed_agent.*` to both;
- `GRANT SELECT ON performance_schema.user_variables_by_thread` to both, which Flyway's boot probe needs.

The statements carry no `IF NOT EXISTS`. The `mysql` client stops at the first failure, so the file never changes an existing database or account. Its comments say how to run it, why it creates two accounts, and that a containerized MySQL needs the account for the gateway host instead. The bootstrap prints only the file's path, then asks the operator to run it as a MySQL administrator and delete it.

### Preflight

A new setting, `qwen.managed-agent.service-user` (`QWEN_MANAGED_AGENT_SERVICE_USER`), names the account the server runs as. A new `service-user` row resolves it:

- `SKIP` when it is not set. The file rows then check access as the process, as before.
- `PASS (this process)` when it names the account running preflight. The rows check access as the process, which is exact.
- `PASS` with the account's groups when `id -Gn` resolves another account.
- `FAIL` when no such account exists, which `id -Gn` shows by printing nothing. It also exits 1 for an account in a group without a name, but then prints that group's number, which is how the file attributes name it too, so preflight keeps the groups.
- `WARN` when `id` cannot run. The rows fall back to the process.

For a resolved account, the `config` and `credentials` rows walk the file's path as the kernel resolves it. The account must be able to enter every directory the walk looks a name up in, including the directories on the way to a symbolic link and those along its target, and it must be able to read the file. Access is judged with the same owner, group and others order. More than 40 links in one path count as unreadable, as the kernel's `ELOOP` does. A failure reads "`<path>` is not readable by `<account>`", and the fix names the `chown`, the `chmod 600` and the directories. A filesystem without POSIX attributes falls back to the process check.

## Failure semantics

- `--service-user` while not root, with a malformed name, or with an unknown account: the bootstrap exits 1 before writing anything.
- A directory the account cannot enter: exit 1, naming the directory, before any file is written. A configuration directory the bootstrap created in this run stays.
- `QWEN_MANAGED_AGENT_SERVICE_USER` names a missing account: the `service-user` row fails, so `--check` exits 1.
- A secret file the account cannot read: the `config` or `credentials` row fails, so `--check` exits 1.

## Compatibility and risks

- Without `--service-user`, the files keep their owners and `0600` mode. The new `mysql-setup.sql` is also `0600`.
- `server.env` now carries a generated password instead of `replace-me`. A deployment that uses its own database account replaces that line, as before.
- `server.env.example` sets `QWEN_MANAGED_AGENT_SERVICE_USER=qwen-managed-agent`, matching the units' `User=`. A deployment that renames the account changes both.
- The access check ignores ACLs, so a file shared through an ACL can fail the row although the account can read it. The shipped layout uses no ACLs.

## Validation plan

- Bootstrap unit tests:
  - the rendered `server.env` with and without the account, and the exact SQL statements;
  - name, root and lookup refusals from `lookupServiceUser`;
  - the owner, group and others order in `accountCanEnter`;
  - the directories `directoriesToEnter` lists for an absolute and a relative symbolic link, and a link loop.
- A root-only bootstrap test with `nobody`: a `0700` parent refuses before any file is written, and after `chmod 755` every file and the directory get the table's owners and modes. A link to a directory under a `0700` directory refuses too, naming that directory, and writes nothing.
- `ServiceAccountTest`: the bit order on real files, every directory above the file, a directory on either side of a symbolic link, a link loop, a missing file, and a real `id` lookup.
- `ManagedAgentPreflightTest`: each `service-user` row state, and the `config` and `credentials` rows failing for an account that cannot read the file while passing for its owner.
- End to end as root with a new system account and MySQL on the host network:
  - the bootstrap gives the files their owners;
  - the generated SQL creates the database, and the server starts as the account and completes a Turn;
  - `--check` run as root passes, then fails `credentials` once `harness.env` is root-owned, which a check as root alone reported as PASS.

## Acceptance criteria

- `bootstrap --directory /etc/qwen-managed-agent --service-user qwen-managed-agent` followed by the SQL leaves nothing to edit except the Workspace directory.
- A root `--check` reports a file the service account cannot read.
- No secret appears in the bootstrap's output.

## Follow-up work

- Check the Workspace and Runtime state directories as the service account too.
