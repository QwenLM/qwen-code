package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeBackendSelection;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeSupport;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;

/** Discovers factories only. Validation and resource creation belong to the selected factory. */
public final class RuntimeProviderRegistry {
    private final ExternalRuntimeClient externalClient;
    private final Map<String, RuntimeProviderFactory> factories = new LinkedHashMap<>();

    public RuntimeProviderRegistry() {
        this(discover());
    }

    public RuntimeProviderRegistry(ExternalRuntimeClient externalClient) {
        this(discover(), externalClient);
    }

    // Broker callbacks can run on threads whose context loader cannot see the host's provider
    // JARs, while hosts may supply extra providers only through a child context loader.
    private static Iterable<RuntimeProviderFactory> discover() {
        ClassLoader application = RuntimeProviderRegistry.class.getClassLoader();
        ClassLoader context = Thread.currentThread().getContextClassLoader();
        if (context == null || context == application) {
            return ServiceLoader.load(RuntimeProviderFactory.class, application);
        }
        // The child loader also sees the parent's built-ins; keep one factory per class so the
        // duplicate-kind guard only rejects genuinely distinct providers.
        Map<Class<?>, RuntimeProviderFactory> byClass = new LinkedHashMap<>();
        for (ClassLoader loader : List.of(application, context)) {
            ServiceLoader.load(RuntimeProviderFactory.class, loader)
                    .forEach(factory -> byClass.putIfAbsent(factory.getClass(), factory));
        }
        return byClass.values();
    }

    RuntimeProviderRegistry(Iterable<RuntimeProviderFactory> providers) {
        this(providers, null);
    }

    private RuntimeProviderRegistry(Iterable<RuntimeProviderFactory> providers, ExternalRuntimeClient externalClient) {
        this.externalClient = externalClient;
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
        factory.validate(settings, dependencies);
        RuntimeProvisioner provider = factory.create(settings, transport, dependencies);
        if (!kind.equals(provider.kind())) {
            provider.close();
            throw new IllegalStateException("Runtime provider kind differs from configured kind: " + kind);
        }
        return provider;
    }

    public void validateSelected(ManagedAgentSettings settings) {
        validateSelected(settings, null);
    }

    public void validateSelected(ManagedAgentSettings settings, RuntimeProviderDependencies dependencies) {
        for (String kind : RuntimeBackendSelection.from(settings).kinds().stream().sorted().toList()) {
            RuntimeProviderFactory factory = require(kind);
            if (externalClient == null) {
                factory.validate(settings);
            } else {
                factory.validate(settings, dependencies);
            }
        }
    }

    public SshRuntimeSupport ssh() {
        if (require("ssh-process") instanceof SshRuntimeSupport support) {
            return support;
        }
        throw new IllegalStateException("Installed SSH Runtime provider does not support shared connections");
    }
}
