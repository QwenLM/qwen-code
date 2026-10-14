package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

final class HostedProbeStorageOwners {
    private HostedProbeStorageOwners() {
    }

    static Map<String, Object> owner(JdbcTemplate jdbc, String tenant, String storage) {
        return jdbc.queryForMap("SELECT o.* FROM ma_storage_owner o"
                + " JOIN ma_storage s ON s.physical_key = o.storage_key"
                + " WHERE s.alias_key = ? AND s.tenant_id = ? AND s.storage_id = ?",
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage), tenant, storage);
    }
}
