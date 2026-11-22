package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeBackendSelection;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeSupport;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.ServiceLoader;

/** Discovers factories only. Validation and resource creation belong to the selected factory. */
public final class RuntimeProviderRegistry {
    private final Map<String, RuntimeProviderFactory> factories = new LinkedHashMap<>();

    public RuntimeProviderRegistry() {
        // Broker callbacks can run on threads whose context loader cannot see the host's provider JARs.
        this(ServiceLoader.load(RuntimeProviderFactory.class, RuntimeProviderRegistry.class.getClassLoader()));
    }

    RuntimeProviderRegistry(Iterable<RuntimeProviderFactory> providers) {
        for (RuntimeProviderFactory factory : providers) {
            for (String kind : factory.kinds()) {
                BrokerValues.requireId(kind, "Runtime provider kind");
                if (factories.putIfAbsent(kind, factory) != null) {
                    throw new IllegalStateException("Duplicate Runtime provider kind: " + kind);
                }
            }
        }
    }

    public RuntimeProviderFactory require(String kind) {
        RuntimeProviderFactory factory = factories.get(kind);
        if (factory == null) {
            throw new IllegalStateException("Runtime provider is not installed: " + kind
                    + "; add its provider JAR (installed: " + factories.keySet() + ")");
        }
        return factory;
    }

    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        return create(settings.getRuntimeBroker().getProvisioner(), settings, transport, dependencies);
    }

    public RuntimeProvisioner create(String kind, ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        RuntimeProviderFactory factory = require(kind);
        factory.validate(settings);
        RuntimeProvisioner provider = factory.create(settings, transport, dependencies);
        if (!kind.equals(provider.kind())) {
            provider.close();
            throw new IllegalStateException("Runtime provider kind differs from configured kind: " + kind);
        }
        return provider;
    }

    public void validateSelected(ManagedAgentSettings settings) {
        for (String kind : RuntimeBackendSelection.from(settings).kinds().stream().sorted().toList()) {
            require(kind).validate(settings);
        }
    }

    public SshRuntimeSupport ssh() {
        if (require("ssh-process") instanceof SshRuntimeSupport support) {
            return support;
        }
        throw new IllegalStateException("Installed SSH Runtime provider does not support shared connections");
    }
}
