package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

class HostedProbeStorageOwnersTest {
    private static final String TENANT = "tenant";
    private static final String STORAGE = "storage-0";
    private static final String PHYSICAL = ManagedSchemaKeys.key("physical-owner");
    private JdbcTemplate jdbc;
    private String legacy;

    @BeforeEach
    void setUp() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:hosted-owner-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        legacy = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((TENANT + "\u0000" + STORAGE).getBytes(StandardCharsets.UTF_8)));
        for (String key : new String[] {PHYSICAL, legacy}) {
            jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, tenant_id, storage_id)"
                    + " VALUES (?, ?, ?, ?)", key, key, TENANT, STORAGE);
        }
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id,"
                + " physical_key, registration_state, storage_kind, registration_revision, registration_json)"
                + " VALUES (?, ?, ?, ?, ?, ?, 'REGISTERED', 'LOCAL', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE), ManagedSchemaKeys.key(TENANT),
                ManagedSchemaKeys.key(STORAGE), TENANT, STORAGE, PHYSICAL);
    }

    @Test
    void readsThePhysicalOwnerInsteadOfAnExistingLegacyHashDecoy() {
        assertThat(HostedProbeStorageOwners.owner(jdbc, TENANT, STORAGE).get("storage_key"))
                .isEqualTo(PHYSICAL).isNotEqualTo(legacy);
    }

    @Test
    void rejectsARawTenantMismatchDespiteTheMatchingAliasKey() {
        jdbc.update("UPDATE ma_storage SET tenant_id = ?", "Tenant");
        assertThatThrownBy(() -> HostedProbeStorageOwners.owner(jdbc, TENANT, STORAGE))
                .isInstanceOf(EmptyResultDataAccessException.class);
    }

    @Test
    void rejectsARawStorageMismatchDespiteTheMatchingAliasKey() {
        jdbc.update("UPDATE ma_storage SET storage_id = ?", "storage-0 ");
        assertThatThrownBy(() -> HostedProbeStorageOwners.owner(jdbc, TENANT, STORAGE))
                .isInstanceOf(EmptyResultDataAccessException.class);
    }

    @Test
    void doesNotUseTheLegacyDecoyWhenThePhysicalOwnerIsMissing() {
        jdbc.update("DELETE FROM ma_storage_owner WHERE storage_key = ?", PHYSICAL);
        assertThatThrownBy(() -> HostedProbeStorageOwners.owner(jdbc, TENANT, STORAGE))
                .isInstanceOf(EmptyResultDataAccessException.class);
    }
}
