package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class WorkspaceCsiRuntimeProvisionerTest {
    private DriverManagerDataSource source;
    private WorkspaceCsiReservationStore storage;
    private JdbcRuntimeBindingRepository bindings;

    @BeforeEach
    void setUp() {
        source = new DriverManagerDataSource("jdbc:h2:mem:csi-broker-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        storage = new WorkspaceCsiReservationStore(new JdbcTemplate(source),
                new DataSourceTransactionManager(source), new ObjectMapper());
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test-key", new byte[32]));
    }

    @Test
    void realBrokerBusyKeepsTheOriginalBindingAndOtherPhysicalOwnerAcrossRestart() {
        var first = registration("first", "storage");
        var alias = registration("second", "alias");
        storage.register(first);
        storage.register(alias);
        var firstProvider = new WorkspaceCsiRuntimeProvisioner(storage, bindings, first);
        var created = bindings.findOrCreate(firstProvider.createRequest(scope(first), "holder"));
        var claimed = bindings.claimOperation(created.getBindingId(), "holder", Duration.ofMinutes(5));
        firstProvider.reserveResource(claimed);
        var originalOwner = storage.inspect(first);
        new WorkspaceCsiRuntimeProvisioner(storage, bindings, first).reserveResource(claimed);
        assertThat(storage.inspect(first)).isEqualTo(originalOwner);

        var secondProvider = new WorkspaceCsiRuntimeProvisioner(storage, bindings, alias);
        var original = bindings.findOrCreate(secondProvider.createRequest(scope(alias), "harness"));
        for (int restart = 0; restart < 2; restart++) {
            try (var broker = broker(new WorkspaceCsiRuntimeProvisioner(storage, bindings, alias), alias)) {
                for (int retry = 0; retry < 2; retry++) {
                    assertFailure(broker.warm("harness"), "workspace_csi_busy");
                    var current = bindings.findById(original.getBindingId());
                    assertThat(current.getState()).isEqualTo(RuntimeBindingRecord.State.PROVISIONING);
                    assertThat(current.getGeneration()).isEqualTo(original.getGeneration());
                    assertThat(current.getProvisionSeed()).isEqualTo(original.getProvisionSeed());
                    assertThat(current.getResourceHandle()).isNull();
                    assertThat(current.getOperationOwner()).isNull();
                    assertThat(storage.inspect(first)).isEqualTo(originalOwner);
                }
            }
        }
    }

    @Test
    void successfulReservationRemainsHeldWhenWorkerProvenanceIsClosed() {
        var registration = registration("tenant", "storage");
        storage.register(registration);
        var provider = new WorkspaceCsiRuntimeProvisioner(storage, bindings, registration);
        var original = bindings.findOrCreate(provider.createRequest(scope(registration), "harness"));
        try (var broker = broker(provider, registration)) {
            assertFailure(broker.warm("harness"), "workspace_csi_provenance_unavailable");
            assertThat(bindings.findById(original.getBindingId()).getState())
                    .isEqualTo(RuntimeBindingRecord.State.RECOVERY_BLOCKED);
        }
        var reserved = storage.inspect(registration);
        assertThat(reserved.phase()).isEqualTo("RESERVED");
        assertThat(reserved.bindingId()).isEqualTo(original.getBindingId());
        assertThat(reserved.provisionRequestId()).isEqualTo(original.getProvisionSeed().getProvisionRequestId());
        try (var broker = broker(new WorkspaceCsiRuntimeProvisioner(storage, bindings, registration), registration)) {
            assertFailure(broker.warm("harness"), "runtime_broker_recovery_blocked");
        }
        assertThat(storage.inspect(registration)).isEqualTo(reserved);
    }

    private RuntimeBrokerService broker(WorkspaceCsiRuntimeProvisioner provider, WorkspaceCsiRegistration registration) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope(registration)), provider,
                new HttpRuntimeTransport(), bindings, new JdbcRuntimeSessionRepository(source),
                new JdbcToolExecutionRepository(source), "coordinator", Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    private static RuntimeScope scope(WorkspaceCsiRegistration registration) {
        return new RuntimeScope(registration.tenantId(), "workspace", "1", registration.mountRoot(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
    }

    private static WorkspaceCsiRegistration registration(String tenant, String storage) {
        return new WorkspaceCsiRegistration(tenant, storage, "cluster", "runtime-test", "claim", "pvc-uid",
                "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "opaque-handle", "backend", "serial", "/workspace", 1);
    }

    private static void assertFailure(CompletionStage<?> stage, String code) {
        assertThatThrownBy(() -> stage.toCompletableFuture().join()).hasCauseInstanceOf(RuntimeBrokerException.class)
                .satisfies(error -> assertThat(((RuntimeBrokerException) error.getCause()).getCode()).isEqualTo(code));
    }
}
