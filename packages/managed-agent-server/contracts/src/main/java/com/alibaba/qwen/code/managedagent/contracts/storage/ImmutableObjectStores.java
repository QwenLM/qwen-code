package com.alibaba.qwen.code.managedagent.contracts.storage;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceLoader;

/** The same startup loader is used by the service and standalone operator tools. */
public final class ImmutableObjectStores {
    private final Map<String, ImmutableObjectStoreFactory> factories = new LinkedHashMap<>();

    public ImmutableObjectStores() {
        this(ServiceLoader.load(ImmutableObjectStoreFactory.class));
    }

    public ImmutableObjectStores(Iterable<ImmutableObjectStoreFactory> providers) {
        for (ImmutableObjectStoreFactory provider : providers) {
            String kind = provider.kind();
            if (kind == null || !kind.matches("[a-z][a-z0-9-]{0,63}")
                    || factories.putIfAbsent(kind, provider) != null) {
                throw new IllegalStateException("Invalid or duplicate object storage provider: " + kind);
            }
        }
    }

    public ImmutableObjectStore create(String kind, Map<String, String> options) {
        ImmutableObjectStoreFactory factory = factories.get(kind);
        if (factory == null) {
            throw new IllegalStateException("Object storage provider is not installed: " + kind);
        }
        Map<String, String> frozen = Map.copyOf(options);
        factory.validate(frozen);
        ImmutableObjectStore store = Objects.requireNonNull(factory.create(frozen));
        try {
            String identity = store.identity();
            if (identity == null || identity.isBlank() || identity.length() > 512) {
                throw new IllegalStateException("Object storage identity must contain 1 to 512 characters");
            }
            store.validateConfiguration();
            return store;
        } catch (RuntimeException | Error failure) {
            try {
                store.close();
            } catch (RuntimeException closeFailure) {
                failure.addSuppressed(closeFailure);
            }
            throw failure;
        }
    }
}
