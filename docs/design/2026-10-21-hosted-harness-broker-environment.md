# Hosted Harness Broker Environment and Fixed Port

[English](2026-10-21-hosted-harness-broker-environment.md) | [简体中文](2026-10-21-hosted-harness-broker-environment.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

The shipped systemd unit gives the Hosted Harness the Runtime Broker through `--managed-runtime-broker-url` and `--managed-runtime-broker-token`, by expanding `QWEN_HOSTED_HARNESS_BROKER_ARGS` into the command line. Any local user can read the Broker token from `/proc/<pid>/cmdline`. The unit and its environment template both carry a warning to keep the tool path to single-tenant hosts.

The Broker token is also stored twice. The Harness gets it through `harness.env`, the control plane through `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` in `server.env`, and every rotation must change both.

Separately, `qwen serve` moves to the next free port when the requested one is busy. For the Hosted Harness this is never what the operator wants. The control plane names one fixed Harness URL, so a moved Harness starts cleanly while every Session fails until someone edits `server.env`. The deployment guide and systemd README document this trap instead of preventing it.

## Goals

- No shipped file puts the Broker token on a command line.
- The token does not reach the processes the Harness starts.
- `harness.env` holds the Broker token once for both processes, building on the Harness credentials file.
- A busy Harness port fails startup instead of moving.

## Non-goals

- Changing the default profile's port fallback.
- Changing how the Broker authenticates, or its token format.
- Removing the existing command-line options. They keep working and take precedence.

## Design

### Broker environment

`qwen serve` already falls back to `QWEN_MANAGED_RUNTIME_BROKER_URL` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` when `--managed-runtime-broker-url` and `--managed-runtime-broker-token` are absent, and removes both variables from its environment once read; the local Managed command (#14928) added this. This design uses those variables rather than adding a second pair. `validateHostedHarnessProfile` still requires both values or neither, and only the Hosted Harness profile accepts them.

### Child environment

The token leaves the Harness's own environment once read, so no process the Harness starts inherits it from there. Every list that strips Qwen-internal secrets carries it as well, for embedded callers and for any path that copies an environment before that point:

- `SCRUBBED_CHILD_ENV_KEYS`, which the ACP bridge removes from every `qwen --acp` child, beside `QWEN_SERVER_TOKEN`;
- core's `INTERNAL_SECRET_ENV_VARS`, which shell commands, hooks, the monitor tool and stdio MCP servers start without, and which also stops a repository-supplied `${QWEN_MANAGED_RUNTIME_BROKER_TOKEN}` from resolving in settings, hook or MCP configuration;
- the channel worker environment, which the supervisor builds and the worker scrubs again;
- the control plane's Runtime worker filter, which now also removes the `QWEN_MANAGED_RUNTIME_BROKER_` prefix.

A daemon self-update replaces `qwen serve` through `execve`, which keeps the PID, so systemd never hands the replacement the pair again. The restarter adds the resolved pair to the replacement's environment only, beside the server token, and the replacement removes it once read.

A prompt-injected agent holding the Broker token could otherwise call the Broker directly.

### Fixed port

Under `--profile hosted-harness`, `EADDRINUSE` on the requested port fails startup with a message naming the port. The control plane's `QWEN_MANAGED_AGENT_HARNESS_BASE_URL` points at it, so moving the Harness would break every Session. `--port 0` keeps its ephemeral meaning. The shipped unit restarts a failed Harness every 5 seconds, so a persistent conflict shows as a unit that keeps restarting, with the port message in `journalctl -u qwen-hosted-harness`.

### Shared Broker token

The Harness credentials file gains two optional keys. When `harness.credentials-file` is set and the file contains `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`, the control plane takes `runtime-broker.token` from it. As with the other two keys, a file that sets the key together with a direct `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` fails startup. A file without the key leaves the direct setting in charge, so text-only deployments are unaffected. The Harness also reads `QWEN_MANAGED_RUNTIME_BROKER_URL` from the file, so both lines follow the same rules as the other two: no whitespace around the `=`, and a value of only letters, digits and `._:/+=-`; the URL may also use `[` and `]`, which both readers take literally, to bracket an IPv6 literal. The Harness requires the URL and token together, and takes an empty value as set, so a file with only one of them, or with either one empty, fails startup. A key with whitespace in it fails startup for every line: systemd ignores `export KEY=value`, which a shell assigns, so the two readers would disagree. Binding is atomic: on a conflict, nothing is bound.

The Broker URL in the file is a second copy of the address the Broker binds, which the control plane configures separately. Preflight therefore adds a `broker-url` row while the Broker is enabled and startup read the file. The row first reads the URL the way the Harness does at startup (`managed-runtime-broker-url.ts`): through the WHATWG URL parser, then the Harness's rules, under which the URL must be an `http` or `https` origin and plain `http` is allowed only on a loopback host; otherwise the row fails, because the Harness would refuse to start. A second parser written to approximate Node's disagrees with it in both directions (`http://127.1:4182` is the loopback origin to Node; `http://::1:4182` and port 99999 are not URLs), so `HarnessBrokerUrl` follows the URL Standard step by step for the part a credentials-file value can reach: the file's character set leaves out percent-encoding, user information, a query, a fragment, backslashes, whitespace and non-ASCII text, which leaves the scheme, the slashes after it, the IPv4, IPv6 and ASCII-domain host parsers, the port and the path's dot segments. A label beginning `xn--` would need IDNA, which it does not implement. IDNA keeps such a label or refuses the URL, so that host is never loopback: the row still fails plain `http` or a path there, and warns that it cannot read the URL only for `https`, where IDNA alone decides. A scheme other than `http` or `https` is refused before the rest is read, so a URL the Harness finds invalid, such as `ftp://`, can fail under another reason; the fixture test allows these two differences and no others. `managed-runtime-broker-url.fixtures.json` holds one verdict for each spelling, read the way preflight reads it, which is also the Harness's verdict wherever its URL parser keeps the host; the CLI test checks the Harness against it and `HarnessBrokerUrlTest` checks preflight, so a change to either reader fails one of them. Node's URL parsers disagree on some `xn--` labels. ada 2.9 (Node 22) keeps `xn--localhost-` and refuses `xn--a`. ada 3 (Node 24.0 to 24.19, and 25) refuses both, and ada 4 (Node 24.20 and later, and 26) keeps both. Each case with an `xn--` host therefore names that host as `idnaHost` and records the verdict where the parser keeps it, which is also how preflight reads it. Where the running parser refuses the host, the CLI test expects `invalid`; elsewhere it expects the recorded verdict. The row then passes only when the URL names the Broker's own listener directly: `http`, `runtime-broker.port`, and a host that resolves to an address the bind serves, which is `runtime-broker.host` itself or, for a wildcard bind, any address of this machine in the bind's family. The JDK binds `::` only on a dual-stack socket, so it serves IPv4 too, but it binds `0.0.0.0` to IPv4 alone under `-Djava.net.preferIPv4Stack=true`, a JVM option the server may get from an environment preflight does not share; an IPv6 URL to an IPv4 wildcard therefore warns, and the fix names the IPv4 loopback URL. An `https` URL to that same listener fails, because the embedded Broker serves plain HTTP. Any other URL warns: it may be a proxy or TLS front end that forwards to the Broker, which preflight cannot verify, so it does not fail `--check`. The row also warns when the file has no Broker URL. Its fix names the direct loopback URL, built from the address the bind resolves to rather than its configured spelling, when the Broker binds loopback or a wildcard address, and otherwise the TLS-terminating proxy, because the Harness refuses plain `http` to a non-loopback address. The `broker` rows also fail when the Broker binds outside loopback without `runtime-broker.allow-non-loopback`, which the Broker itself refuses at startup.

### Templates and documentation

- The bootstrap writes the generated Broker token to `harness.env` as `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`, with `QWEN_MANAGED_RUNTIME_BROKER_URL=http://127.0.0.1:4182` beside it. `server.env` no longer carries the token.
- `harness.env.example` lists both variables, commented, for the tool path.
- The Harness unit drops `$QWEN_HOSTED_HARNESS_BROKER_ARGS` from `ExecStart`, along with the single-tenant warning that existed because of it.
- The deployment guide, the systemd README (English and Chinese) and the server README describe the variables and the fixed port. They also drop the instruction to update the base URL when the port moves, and tell upgraded hosts to replace a `QWEN_HOSTED_HARNESS_BROKER_ARGS` line.

## Compatibility and risks

- Deployments that pass the command-line options are unchanged; an option still wins over its variable.
- A Hosted Harness that previously moved to a free port now fails to start. That failure is the intended signal; the previous behaviour produced a running Harness that no Session could reach.
- A deployment that sets the Broker token both in `harness.env` and directly in `server.env` fails at startup until one copy is removed.
- Nothing reads `QWEN_HOSTED_HARNESS_BROKER_ARGS` any more. An upgraded tool-path host must replace that line with `QWEN_MANAGED_RUNTIME_BROKER_URL` and `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`; until it does, the Harness starts without a Broker and the `broker-url` row warns. The control plane still accepts and ignores the old line.
- The bootstrap writes the Broker pair uncommented, so a Harness started from its files gets a Broker address even on a text-only deployment. The Harness dials the Broker only for a tool-path Session, so nothing connects to it until the tool path is enabled.

## Validation plan

- CLI unit tests: the ACP child, the channel worker and core's child environment omit the token, and a `${QWEN_MANAGED_RUNTIME_BROKER_TOKEN}` placeholder stays unresolved; a daemon update restart hands the replacement the resolved pair.
- A CLI test that a busy port fails the Hosted Harness profile, while the default profile still moves to the next port.
- Java unit tests:
  - the optional Broker token key is resolved from the file; a conflict with the direct setting fails and binds nothing; an absent key leaves the direct value;
  - the Broker URL and token lines are held to the credential rules;
  - the `broker-url` row passes a direct `http` URL, fails `https` to the plain-HTTP listener, a URL with a path, a non-`http(s)` scheme and plain `http` to a non-loopback host, and warns on a moved port or host, another loopback address, an IPv4 URL for an IPv6 loopback bind, an IPv6 URL for an IPv4 wildcard bind, and a TLS front end on another port; its fix never names plain `http` for a non-loopback bind, and the URL it names passes;
  - preflight and the Harness give each spelling in the shared fixture the same verdict, including inet_aton forms, missing or extra slashes, dot segments, an unbracketed IPv6 host, octal octets, an out-of-range port and hosts with an `xn--` label;
  - the credentials file binds a bracketed IPv6 URL, and refuses a URL or token without the other, an empty URL or token, and an `export` line;
  - the broker row's fix names the file only when startup read it;
  - Runtime workers do not inherit the token.
- Template tests: `server.env` carries no Broker token, `harness.env` carries both variables, the template lists both commented, and the unit loads `harness.env` with no Broker arguments in `ExecStart`.
- End to end with the bootstrap files:
  - the Harness starts from `harness.env` with no Broker arguments;
  - the Broker token is absent from the Harness's `/proc/<pid>/cmdline`, and no child process of the Harness carries it;
  - the tool-path server starts and completes a Turn;
  - a second Harness on the same port fails startup.

## Acceptance criteria

- No shipped file places the Broker token on a command line, and it is stored once.
- The processes the Harness starts do not inherit the token.
- A busy Hosted Harness port stops startup with a message naming it.
- Existing command-line configuration behaves as before.

## Follow-up work

None planned within the deployment-ease series beyond publishing the first reference prerelease.
