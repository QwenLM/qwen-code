# Qwen Managed Runtime Broker

This Java 11 module is an embeddable control-plane component. It owns Runtime
placement, Harness-to-Runtime Session bindings, and tool execution identities.
It must not run the model loop or accept tenant/workspace claims from the
Harness.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

Keep the core independent of Spring or a specific scheduler. Product services
adapt their authenticated Session store through `HarnessSessionResolver` and
their placement system through `RuntimeProvisioner`.
