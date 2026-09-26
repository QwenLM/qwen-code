# Qwen Managed Runtime Broker State

Keep this module independent of Spring, Qwen Code CLI internals, and any
specific Runtime scheduler. Repository contracts define the persistence
boundary; in-memory implementations are reference implementations for tests
and single-process prototypes only. Production integrations should provide a
shared `DataSource`, initialize the JDBC schema through their normal migration
system, and inject the JDBC repositories. `JdbcRuntimeBindingRepository` also
requires a `SecretProtector` (`AesGcmSecretProtector` is included) whose key
material comes from the integration's own durable secret store and stays
stable across restarts and instances, because the provision seed and the legacy
lease token are stored encrypted. Never silently fall back to in-memory
state on a JDBC failure.

Do not treat a persisted `READY` binding as proof that its Runtime process is
alive. The Broker reconciles and adopts bindings through recovery-capable
provisioners. The embedding service owns those provisioners, reprovisioning
policy, and Session rebind policy.

Use JDK 21 or later to build and run this module.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

## Workspace binding package

Keep `com.alibaba.qwen.code.runtimebroker.managedworkspace` on the JDK alone:
no other Broker class, Spring, CLI internals or scheduler.

Treat every caller-supplied Workspace ID and directory as untrusted input.
Resolution reports one typed error, never lets an explicit selection fall
back to the default Workspace, never falls back to a launch directory, and
never reveals whether another tenant's Workspace exists. Keep missing, foreign and unreadable Workspaces on one throw site,
and have API adapters return only the status, code and message of a
`WorkspaceException`, never its stack trace. The working-directory rule is
lexical; do not add filesystem checks there, because the Runtime verifies the
directory where the files live.

A decoder that builds a `ContextBinding` from text must accept only the ASCII
form `[1-9][0-9]*`, at most 2^63−1, for the generation and the revision, as
the TypeScript implementation does. `Long.parseLong` alone also accepts a
sign, leading zeros and non-ASCII digits.

A change to the directory rule or to the `ContextBinding` encoding must
update, in the same change, the shared fixtures in
`packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json`
and `packages/cli/src/serve/managed-workspace-binding.ts`, so both languages
keep producing the same bytes. The installation requests and receipts in
`packages/cli/src/serve/contracts/managed-context-v1.fixtures.json` carry
context digests computed with the same encoding, and
`ManagedContextEnvelopeConformanceTest` recomputes them, so update them too.
Compute new expected values with an implementation independent of both. Both
fixture files carry unpaired surrogates as `\uXXXX` escapes on purpose; read
them with a parser that keeps such escapes, as Jackson does. `jq` rejects the
files, and Go's `encoding/json` replaces the surrogates with U+FFFD.
