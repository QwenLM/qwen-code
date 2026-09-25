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
