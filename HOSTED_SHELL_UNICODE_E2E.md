# Hosted Shell Unicode E2E

This guide covers the real-process gate for the fix described in the
[English design](docs/design/managed-agents/2026-10-08-hosted-shell-unicode-admission.md)
and the [Chinese design](docs/design/managed-agents/2026-10-08-hosted-shell-unicode-admission.zh-CN.md).
It covers one behavior: a Hosted Shell call that carries an unpaired UTF-16
surrogate is refused before Workspace admission, the refusal is durable, and the
model can correct the call in the same turn.

## What the test proves

The gate runs one JUnit parameterized test with two capture paths, `local` and
`o2`. For each capture path it proves these points:

- Eight standalone malformed batches produce ordered, paired tool errors. The
  matrix is `command` and `description`, each with `\ud800`, `\udc00`,
  `😀\ud800`, and `\udc00\ud800`.
- The only Broker requests these batches make end in `/runtimes:warm`, which
  means no `acquire`, `prepare`, or `start` request. Runtime warming starts
  before the model output, so the test allows it.
- The driver observes no new entry in the publication reservation list.
- Neither the malformed shell command nor its valid `write_file` sibling creates
  a file.
- Session detach and load keep the original arguments and the paired errors.
- A corrected command runs once in the same prompt turn. It preserves Chinese
  text, emoji, combining characters, and the literal six-character `\ud800`.
- A second Session on the same Workspace runs a valid call. Neither path becomes
  `recoveryBlocked`.

The test uses the `hosted-workspace-shell/1` profile. The `/2` profile has unit
coverage only.

## Prerequisites

- Node.js 22 or later.
- JDK 21. Set `JAVA_HOME` to it.
- Maven 3.8.9 or later.
- Installed workspace dependencies.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
```

## Build the CLI

The Java gate runs the bundled CLI as the Runtime worker, so build it first:

```bash
npm run build
npm run bundle
```

The gate reads `dist/cli.js`. Set `qwen.cli.entry` to that file when you run the
test.

## Install the Java prerequisite

The Runtime Broker module no longer has its own POM; the server module uses the
`qwencode` module:

```bash
mvn -q -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

## Run the gate

Compile the server and its tests first:

```bash
mvn -f packages/managed-agent-server/pom.xml -DskipTests test-compile
```

Then run the single test method through the failsafe plugin:

```bash
mvn -f packages/managed-agent-server/pom.xml \
  -Phosted-workspace-tools \
  -Dnode.executable="$(command -v node)" \
  -Dqwen.cli.entry="$PWD/dist/cli.js" \
  -Dit.test='HostedWorkspaceToolTurnIT#malformedShellUnicodeIsCorrectableBeforeAcquisition' \
  failsafe:integration-test failsafe:verify
```

Do not add `-Dtest=none` or `-Dsurefire.failIfNoSpecifiedTests=false`. The
module sets `failIfNoTests` to `true`, and that combination stops the build at
surefire with `No tests were executed!`.

## Success conditions

The run passes when all of these lines appear:

```text
HOSTED_SHELL_UNICODE_OK: local, 9 refusals per capture, durable reload, Unicode correction, second Session
HOSTED_SHELL_UNICODE_OK: o2, 9 refusals per capture, durable reload, Unicode correction, second Session
Tests run: 2, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

The Druid `testWhileIdle is true, validationQuery not set` line is expected and
does not indicate a failure.

## Recorded result

Measured on macOS arm64 with Node.js 22.23.3, JDK 21.0.13, and Maven 3.9.9, on
the merge of `main` `ce8a94706b` into the PR branch:

```text
HOSTED_SHELL_UNICODE_OK: local, 9 refusals per capture, durable reload, Unicode correction, second Session
HOSTED_SHELL_UNICODE_OK: o2, 9 refusals per capture, durable reload, Unicode correction, second Session
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 11.79 s -- in com.alibaba.qwen.code.managedagent.HostedWorkspaceToolTurnIT
[INFO] BUILD SUCCESS
```

## Test environment

The gate runs in one JVM and starts these real components:

- The managed-agent server with a temporary H2 database in MySQL mode.
- An `EmbeddedRuntimeBroker`.
- A real Node worker process that runs `dist/cli.js`.
- A deterministic fake OpenAI server that sends the malformed JSON escapes.

O2 uses the real Java publication controller and SQL grant and data services. The
object store is an in-memory test adapter. No model API key and no OSS account
are needed.

This is not a MySQL, OSS, Linux, or Windows acceptance run. It also does not
cover a real `hosted-workspace-shell/2` process.

## Troubleshooting

- `POM ... does not exist`: use `packages/sdk-java/qwencode/pom.xml`. The
  `runtime-broker` POM was consolidated and no longer exists.
- `No tests were executed!`: you passed `-Dtest=none`. The module sets
  `failIfNoTests` to `true`, so surefire stops the build. Use the command above.
- `Pass -Dnode.executable with an absolute Node.js 22+ path`: add
  `-Dnode.executable="$(command -v node)"`.
- `AssertionError` about `dist/cli.js` not being a regular file: run
  `npm run bundle` and check `qwen.cli.entry`.
- `recoveryBlocked` in the failure dump: the refusal was not recognized on
  reload. Check that the assistant message and both tool errors were persisted,
  and that the batch has no native tool intent.
