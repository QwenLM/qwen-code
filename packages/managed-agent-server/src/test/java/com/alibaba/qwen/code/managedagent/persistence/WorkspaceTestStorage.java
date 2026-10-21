package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;

/** Explicit storage model for offline SQL tests; native mount tests use the real guard. */
public final class WorkspaceTestStorage {
    private WorkspaceTestStorage() {
    }

    public static String key(String tenant, String storage) {
        return ManagedSchemaKeys.key("offline-test-physical", tenant, storage);
    }

    public static String register(JdbcTemplate jdbc, String tenant, String storage) {
        String physical = key(tenant, storage);
        jdbc.update("INSERT IGNORE INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                + " storage_kind, registration_state, registration_revision, registration_json) VALUES (?, ?, ?, ?, ?, ?, 'LOCAL', 'REGISTERED', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage), JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                JdbcRuntimeBindingRepository.storageFenceKey(storage), tenant, storage, physical);
        jdbc.update("INSERT IGNORE INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id, storage_id, mount_state, mount_revision)"
                + " VALUES (?, ?, 'LOCAL', ?, ?, 'READY', 1)", physical, physical, tenant, storage);
        return physical;
    }
}
