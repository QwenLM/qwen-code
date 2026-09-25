# Qwen Managed Runtime Broker

This Java 11 module is an embeddable control-plane component. It owns Runtime
placement, Harness-to-Runtime Session bindings, and tool execution identities.
It must not run the model loop or accept tenant/workspace claims from the
Harness.

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

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

Keep the core independent of Spring or a specific scheduler. Product services
adapt their authenticated Session store through `HarnessSessionResolver` and
their placement system through `RuntimeProvisioner`.

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
keep producing the same bytes. Compute new expected values with an
implementation independent of both.
