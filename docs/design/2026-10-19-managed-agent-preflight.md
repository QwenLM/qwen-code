# Managed Agent Preflight Command

[English](2026-10-19-managed-agent-preflight.md) | [简体中文](2026-10-19-managed-agent-preflight.zh-CN.md)

Status: implemented in this change.

## Problem

The reference distribution states its prerequisites in prose, but the server
only evaluates them when it starts or when the first Turn runs. A missing
`performance_schema` grant, an empty credential key ring, `auth mode=auto` on a
non-loopback bind, an unreachable Harness, an undersized credential key, an
unwritable Runtime state directory or an occupied port each surface as a
separate failure, and some of them appear only after a Session has been
created. Operators discover the deployment's state one failure at a time.

## Scope

`bin/qwen-managed-agent-server --check` (equivalently
`java -jar qwen-managed-agent-server-<version>.jar --check`) runs the
preflight and exits. It uses the existing server artifact, so the reference
distribution needs no additional component.

The command reads the configuration the server reads, prepared as
`SpringApplication` prepares it before it creates a context, so every input
keeps Spring's precedence:

- the command line (`--server.address=...`, `--qwen.managed-agent.*`);
- `SPRING_APPLICATION_JSON`, then the JVM system properties (`-D…`, such as
  those in `JAVA_TOOL_OPTIONS`), then the rest of the process environment;
- the configuration files Spring Boot reads: those named by
  `spring.config.location`, `spring.config.additional-location` or
  `spring.config.import`, as an argument or a `SPRING_CONFIG_*` variable (the
  launcher sets `SPRING_CONFIG_ADDITIONAL_LOCATION` when
  `config/application.yml` exists, and the systemd unit's `server.env` names
  `/etc/qwen-managed-agent/application.yml`); those at its default locations
  `./`, `./config/` and `./config/*/`; as `.yml`, `.yaml`, `.properties` or
  `.xml`, under `spring.config.name`; their profile variants, the files they
  import and config trees;
- the classpath `application.yml` that maps `QWEN_MANAGED_AGENT_*` variables.

`spring.config.location` replaces every default location, the classpath ones
among them, so with it set the server reads only the locations it names. Unless
it names `classpath:/`, that leaves out the classpath `application.yml`: a
variable only that file maps, such as `QWEN_MANAGED_AGENT_SERVER_ADDRESS`, then
sets nothing, and its defaults, such as the loopback `server.address` and the
Flyway locations, are gone. Without an address the server would listen on every
address, which the default `auth.mode=auto` refuses to start with. Where Spring
prepares the environment, the check reads the same configuration.

Relative locations, the default ones among them, are read in the working
directory, as the server reads them, so the command runs in the server's
working directory: the distribution root, or the unit's `WorkingDirectory`.
Before [#16057](https://github.com/QwenLM/qwen-code/issues/16057) it read only
the file the launcher or `server.env` named, and missed a `server.port` the
server read from `config/application.yml` in its working directory.

## Checks

| Check        | Passing condition                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version is 21 or later.                                                                                                                                                                                                                                                              |
| `config`     | One row per file the server reads: readable by the service account; WARN for none, or where group or others can read one with a secret. FAIL where Spring would not start, for a YAML error, with its line and usually its file, or where this process cannot look in a directory or read a file.    |
| `key-ring`   | At least an active key ID is configured; previous key IDs are reported.                                                                                                                                                                                                                              |
| `validation` | The startup property validations accept the bound configuration.                                                                                                                                                                                                                                     |
| `auth`       | A non-loopback bind does not use `auto`; signed mode has a signing key; insecure bind is reported.                                                                                                                                                                                                   |
| `harness`    | Enabled Harness has a token and a well-formed digest, answers `GET /capabilities` with 200, and negotiates as the first Session does, including the capability digest and each Workspace profile's lifecycle; another Qwen Code version than the manifest's warns. A Harness pool is not negotiated. |
| `tool-path`  | Workspace files and Shell enablement, the isolation class, and the mount, creation-root or SSH-node requirement match the startup rules.                                                                                                                                                             |
| `broker`     | Token, active and previous credential keys decode to 32 bytes, the state directory is writable, and the provisioner's Node/worker or static endpoint is present.                                                                                                                                     |
| `workspace`  | The configured Workspace `cwd` exists and is writable.                                                                                                                                                                                                                                               |
| `*-port`     | The server port and the enabled broker port can be bound, or, with `--online`, accept a connection.                                                                                                                                                                                                  |
| `workers`    | No Runtime worker of an earlier run is alive in the local-process state directory.                                                                                                                                                                                                                   |
| `database`   | MySQL answers `SELECT 1`, the `performance_schema` grant works, and the Flyway version matches the release manifest when that manifest is present.                                                                                                                                                   |

`WARN` and `SKIP` do not fail the command. Any `FAIL` makes the exit code 1.
The port checks bind the configured addresses, so run the command while the
service is stopped, or pass `--online` against a running service.
[2026-10-23-managed-agent-preflight-harness-workers-online.md](2026-10-23-managed-agent-preflight-harness-workers-online.md)
describes the Harness negotiation, the `workers` row and `--online`.

## Non-goals

- It does not negotiate with each endpoint of a Harness pool. With
  `harness.pool.enabled`, the `harness` row skips a pool's endpoints once the
  Session Store is enabled with a binding key, and fails until then, mirroring
  the startup guard.
- It does not verify Workspace mount registration or storage identity; those
  remain the "Verified physical Workspace recovery" procedure's responsibility.
- It never repairs, migrates or writes. Read-only probes only.

## Implementation

`ManagedAgentServerApplication` intercepts `--check` before
`SpringApplication.run`, so no listener, scheduler, datasource pool or worker
starts. `ServerEnvironment` prepares a servlet environment as
`SpringApplication` does: the arguments, the process environment, then every
environment post-processor on the class path through
`EnvironmentPostProcessorApplicationListener`, and relaxed binding. It starts
no context, and `ResolvedConfiguration`, which the upgrade command reads its
settings through, prepares the same environment. The `config` rows name the
files the prepared property sources came from, then the files Spring read at a
location without finding a setting. The check does not read a location's
spelling itself: it records each file Spring's own resolver looks a
configuration file up at, there or not, so a scheme in another case, a
`resource:` prefix, an extension hint, a bare name with a colon, an empty
`spring.config.location` or `spring.config.name`, and each variant of a profile
Spring activates come out as Spring reads them. With each file it records the
property source loader that opens it, YAML's or .properties', which reads a name
ending in `.xml` as XML: the format the file is read in for a secret, so
`file:app.yml[.properties]` is read as .properties. Spring opens a config tree and
lists a wildcard's directories without such a lookup, so those two come from the
location values, read with Spring's location rules: a wildcard's directories,
but none whose name starts with `..`, as Spring skips those, and in each, the
files of a directory location or the one name of a file's wildcard, each in the
format of the loader Spring picks for its name, unless Spring read the file
through a lookup, in a format that then stands. A relative import in a file
Spring read through a wildcard is one more wildcard, as Spring reads it beside the wildcard and
so in each of its directories: `config/*/extra.yml` for one in
`config/*/application.yml`. A wildcard's file name that is only an extension, as
`*/properties`, leaves Spring a location it refuses, which the row reports. A
directory there that this process cannot list or enter is named as one it cannot
look in.
When the preparation throws, the row names what Spring refused: the file, read
as missing or unreadable, or the YAML error's file and line, found among the
files Spring looked for before it refused, since Spring's error names neither: each file Spring reads as YAML, read as Spring's loader reads it but within the limits on aliases and recursive keys Spring lifts, whose own error is Spring's, the same
problem at the same place, unless a profile the arguments or the environment
activate tells which one Spring read; a file this process cannot read names the
service account when that cannot read it either, and otherwise says to run the
check as that account. The other rows then read the arguments, the process
environment and the packaged defaults. Where the preparation succeeds but a
setting a row reads does not resolve, such as a placeholder with no value and
no default, that row fails with Spring's reason and the others still print.
Where the preparation succeeds but the check cannot tell which files Spring
read, as for an import whose placeholders refer to each other, the files the
property sources name and those a loader was seen to read keep their rows, a
file a wildcard found judged in either format its hint may name; one more
`config` row warns with the reason, and the other rows still print.

Spring skips an optional file it cannot see, so where this process cannot enter
a directory the server looks in for a configuration file or a config tree, or
list one it lists, as it lists `config/` for `config/*/`, a `config` row names
that directory and says to run the check as the service account or as root, or
as root alone when that is the service account. When that account cannot look
in it either, Spring reads nothing there, and the directory gets no row; nor
does it without a service account, or when the check runs as that account, as
this process then stands in for the server's, as it does for every file row. A
service account of root reads and enters whatever the modes say, as the kernel
lets it.

A file holds a secret by one rule, the configuration reference's: a key named as
a password, token, key or secret, or a map of keys, in any spelling Spring
binds, and not an ID or the path to a file that holds one; or a value that holds
one, as a JDBC URL's `?password=` parameter or the password of a URL's user
information does. A configuration file is read as Spring reads it, in the format
of the loader that reads it, and the rule judges what that reading declares, in
each document, including one no profile activates, as Spring binds it: a key is
judged by its string, or by whatever a collection Spring writes into the name
holds, wherever a map holds it, a merge's source and a set's members and pairs'
keys among them, which Spring may bind as values or not at all, so the names
judged are a superset of Spring's; and only where its value may bind a
property, so `previous-credential-keys: {}` declares none; a value that holds a
secret
anywhere in the file's text, its comments included; and each comment as the
setting it would be uncommented. A comment is read in the file's format, where a
YAML key with white space in it is prose, as `# Database password: set it in the
environment` is, and no setting; in XML, also entry by entry, as a comment need
be no document; and in YAML and .properties, also as the `key: value` or
`key=value` line both write, quoted or after a list marker, as
`# spring.datasource.password=x` is in YAML. .properties takes white space as a
separator, so `# spring.datasource.password hunter2` counts there; a key that
white space ends counts only with a dot in it, as a property's name has, and a
one-word value, so prose such as `# Password rotation happens yearly` or
`# spring.datasource.password is supplied by the unit environment` does not. A
comment is what the format makes one: in
YAML, from a `#` at the start of a line or after white space to the next such
`#`, however many markers start it, which may also lie in a quoted or block
scalar and only adds text to judge; in .properties, a line that starts with `#`
or `!` after white space, or with one escaped, as `\#` or `\u0023`, which Spring
reads as one too,
but not one a value continues onto, through an odd run
of backslashes at the end of the line before, though a backslash alone where a
key would start continues nothing; the line after a comment that ends in a
backslash, which Spring may read into that comment, is judged as one too; in
XML, what lies between `<!--` and `-->`. YAML, a comment's included, is read
with SnakeYAML set up as Spring's loader sets it up, its nodes composed rather
than built and walked with a stack, each node once. Which nodes lead to a
secret's name is found once for the document, and a node found to bind nothing
is kept, so an alias, which nodes share, is never expanded, and neither a long
chain of them, nor one that holds itself, nor many keys or values that share
one, costs more than a few passes over the nodes. A file a hint names another loader for is
judged as its name says too, comments included, as what Spring does not bind
stays in the file. YAML is decoded as
Spring decodes it, as UTF-8 or as its byte order mark says, so a mark does not
hide a commented-out key on the first line; so is .properties, as ISO-8859-1,
though its comments are found as an editor wrote them: past a UTF-8 mark, which
Spring reads into the first key, and in UTF-16 after its mark, which Spring
reads as ISO-8859-1 throughout. A value file is decoded as UTF-16 after its
mark too. The property a config tree value file holds is judged too. A path can be a
configuration file and a config tree value file at once, as
`config/application.yml` is under a config tree imported over `config/`; it is
then judged both ways. A value file Spring reads as no configuration file holds
its value alone, whatever its name. `Binder` produces
`ManagedAgentProperties`, the Harness probe uses the JDK HTTP client, and the
database probe uses JDBC with a five-second connect and socket timeout.

## Acceptance

- The unit suite covers the digest and key validators, config-location
  precedence, auth verdicts, the Harness probe against a local HTTP server, and
  the broker and tool-path checks.
- `mvn verify` passes both Checkstyle executions and SpotBugs.
- The packaged jar run without a database prints the table, reports the
  connection failure, and exits 1. A deployment with every dependency present
  is expected to exit 0; that path is not covered by this change's local
  verification because no MySQL instance was available.
