package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.util.ReflectionTestUtils;

class HostedStorageOwnerProbeTest {
    private static final String PHYSICAL = "c".repeat(64);
    private static final Map<String, Object> SESSION = Map.of("sessionId", "session");
    private ManagedSchemaJdbcTemplate jdbc;

    @BeforeEach
    void setUp() throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:hosted-owner-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                + " registration_state, storage_kind, registration_revision, registration_json)"
                + " VALUES (?, ?, ?, 'tenant', 'storage-0', ?, 'REGISTERED', 'LOCAL', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage-0"),
                "a".repeat(64), "b".repeat(64), PHYSICAL);
        jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, tenant_id, storage_id, binding_id, mount_state)"
                + " VALUES (?, ?, 'original-tenant', 'original-storage', 'original-binding', 'READY')", PHYSICAL, PHYSICAL);
    }

    @AfterEach
    void tearDown() {
        if (jdbc != null) jdbc.execute("SHUTDOWN");
    }

    static Stream<Class<?>> probes() {
        return Stream.of(HostedCancellationProbe.class, HostedShellOutputProbe.class,
                HostedProviderControlProbe.class, HostedSseGapProbe.class);
    }

    @ParameterizedTest
    @MethodSource("probes")
    void resolvesPhysicalOwnerAndChecksRawAliasIdentity(Class<?> type) {
        Object probe = mock(type, CALLS_REAL_METHODS);
        ReflectionTestUtils.setField(probe, "jdbc", jdbc);
        ReflectionTestUtils.setField(probe, "tenant", "tenant");
        if (!(probe instanceof HostedSseGapProbe)) ReflectionTestUtils.setField(probe, "sessions", List.of(SESSION));
        assertThat(owner(probe)).containsEntry("storage_key", PHYSICAL)
                .containsEntry("binding_id", "original-binding");

        jdbc.update("UPDATE ma_storage SET tenant_id = 'Tenant'");
        assertThatThrownBy(() -> owner(probe)).isInstanceOf(EmptyResultDataAccessException.class);
        jdbc.update("UPDATE ma_storage SET tenant_id = 'tenant', storage_id = 'storage-0 '");
        assertThatThrownBy(() -> owner(probe)).isInstanceOf(EmptyResultDataAccessException.class);
        jdbc.update("UPDATE ma_storage SET storage_id = 'storage-0', physical_key = NULL, registration_state = 'FENCE_ONLY'");
        assertThatThrownBy(() -> owner(probe)).isInstanceOf(EmptyResultDataAccessException.class);
    }

    private static Map<String, Object> owner(Object probe) {
        return probe instanceof HostedSseGapProbe ? ReflectionTestUtils.invokeMethod(probe, "owner")
                : ReflectionTestUtils.invokeMethod(probe, "owner", SESSION);
    }
}
