package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStores;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.StandardEnvironment;

import java.util.Map;

final class OperatorObjectStores {
    private OperatorObjectStores() { }

    static void configure(org.springframework.jdbc.core.JdbcTemplate jdbc,
            org.springframework.transaction.PlatformTransactionManager manager,
            com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore sessions, ImmutableObjectStore objects) {
        var properties = Binder.get(new StandardEnvironment()).bind("qwen.managed-agent", Bindable.of(ManagedAgentProperties.class))
                .orElseGet(ManagedAgentProperties::new);
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        new com.alibaba.qwen.code.managedagent.persistence.SessionObjectResources(jdbc, manager, sessions, objects, properties, json,
                com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy.inProcess());
        sessions.configureJournalAccess(new com.alibaba.qwen.code.managedagent.persistence.JournalColdStorage(jdbc, manager, objects, properties, json));
    }

    static com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore publication(ImmutableObjectStore store) {
        if (store == null) {
            return null;
        }
        var settings = Binder.get(new StandardEnvironment())
                .bind("qwen.managed-agent.object-store", Bindable.of(ManagedAgentProperties.ObjectStore.class))
                .orElseGet(ManagedAgentProperties.ObjectStore::new);
        return new com.alibaba.qwen.code.managedagent.contracts.storage.ToolPublicationObjectStoreAdapter(store, settings.getProvider().isBlank());
    }

    static ImmutableObjectStore open(String legacyPrefix) {
        var settings = Binder.get(new StandardEnvironment())
                .bind("qwen.managed-agent.object-store", Bindable.of(ManagedAgentProperties.ObjectStore.class))
                .orElseGet(ManagedAgentProperties.ObjectStore::new);
        if (!settings.getProvider().isBlank()) {
            return new ImmutableObjectStores().create(settings.getProvider(), settings.getProviderOptions());
        }
        String endpoint = System.getenv(legacyPrefix + "ENDPOINT");
        String region = System.getenv(legacyPrefix + "REGION");
        String bucket = System.getenv(legacyPrefix + "BUCKET");
        if (endpoint == null && region == null && bucket == null) {
            return null;
        }
        if (endpoint == null || region == null || bucket == null) {
            throw new IllegalArgumentException("Incomplete legacy object store configuration");
        }
        return new ImmutableObjectStores().create("aliyun-oss",
                Map.of("endpoint", endpoint, "region", region, "bucket", bucket));
    }
}
