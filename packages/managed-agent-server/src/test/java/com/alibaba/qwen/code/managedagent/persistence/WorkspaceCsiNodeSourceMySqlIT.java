package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCsiNodeSourceMySqlIT {
    @Test
    void refusesIncompleteEvidenceRetirementBeforeChangingTheReadyOwner() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = fixture(database);
            fixture.store().saveArm(fixture.binding(), fixture.registration(), fixture.reservation(),
                    fixture.protocol().configuration(), fixture.protocol().arm());
            var seed = fixture.binding().getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("https://original.example.invalid"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var ready = fixture.bindings().compareAndSet(fixture.binding(), fixture.binding().withAttestation(lease,
                    new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original")), Instant.now(), Instant.now()));
            var storage = new WorkspaceCsiReservationStore(fixture.jdbc(), fixture.manager(), new ObjectMapper());
            var before = fixture.jdbc().queryForMap("SELECT * FROM ma_runtime_binding");
            assertThatThrownBy(() -> storage.beginRetirement(fixture.registration(), fixture.bindings(), ready,
                    fixture.reservation(), UUID.randomUUID().toString())).hasMessageContaining("original CSI node source association");
            assertThat(fixture.jdbc().queryForMap("SELECT * FROM ma_runtime_binding")).isEqualTo(before);
            assertThat(storage.inspect(fixture.registration())).isEqualTo(fixture.reservation());
            assertThat(fixture.store().inspect(ready.getBindingId()).arm().bytes()).isEqualTo(fixture.protocol().arm().bytes());
            assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
            try (var connection = database.source().getConnection()) {
                connection.setReadOnly(true);
                connection.setTransactionIsolation(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
                connection.setAutoCommit(false);
                try {
                    assertThat(WorkspaceCsiNodeSourceStore.hasAssociation(connection, ready.getBindingId(), fixture.registration().physicalKey(), false)).isTrue();
                } finally {
                    connection.rollback();
                }
            }
        }
    }

    @Test
    void migratesPublishedV12WithoutChangingOriginalRows() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION)
                    .target("12").load().migrate();
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            String tables = "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()"
                    + " AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME <> 'flyway_schema_history'";
            var before = new HashSet<>(jdbc.queryForList(tables, String.class));
            assertThat(before).hasSize(32).doesNotContain("ma_csi_source");
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(12);
            jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                    + " VALUES ('tenant','original','qwen-code',1,2)");
            assertThatThrownBy(() -> ManagedSchema.initialize(source)).hasCauseInstanceOf(java.sql.SQLException.class);
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();
            ManagedSchema.validate(source);
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(14);
            var after = new HashSet<>(jdbc.queryForList(tables, String.class));
            assertThat(after.remove("ma_csi_source")).isTrue();
            assertThat(after.remove("ma_csi_physical")).isTrue();
            assertThat(after).isEqualTo(before);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_csi_source", Integer.class)).isZero();
            assertThat(jdbc.queryForMap("SELECT session_id,gmt_create,gmt_modified FROM ma_session"))
                    .containsEntry("session_id", "original").containsEntry("gmt_create", 1L).containsEntry("gmt_modified", 2L);
        }
    }

    @Test
    void migratesPublishedV13WithoutChangingSourceBytes() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var source = database.source();
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION)
                    .target("13").load().migrate();
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(13);
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            byte[] bytes = new byte[] {0, 1, (byte) 255};
            jdbc.update("INSERT INTO ma_csi_source (binding_id,runtime_generation,physical_key,reservation_id,"
                    + "reservation_revision,configuration_json,phase,record_version,arm_bytes,arm_sequence,arm_hash)"
                    + " VALUES (?,1,?, ?,1,'{}','ARMED',1,?,1,?)", "schema-witness".getBytes(StandardCharsets.UTF_8),
                    "a".repeat(64), "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", bytes, "b".repeat(64));
            var before = jdbc.queryForMap("SELECT * FROM ma_csi_source");
            Flyway.configure().dataSource(source).locations(ManagedSchema.FLYWAY_LOCATION).load().migrate();
            ManagedSchema.validate(source);
            assertThat(ManagedSchema.schemaVersion(source)).isEqualTo(14);
            assertThat(jdbc.queryForMap("SELECT * FROM ma_csi_source")).usingRecursiveComparison().isEqualTo(before);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_csi_physical", Integer.class)).isZero();
        }
    }

    @Test
    void preservesExactOriginalPrefixesAcrossStoreRestart() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = fixture(database);
            var protocol = fixture.protocol();
            var store = fixture.store();
            store.saveArm(fixture.binding(), fixture.registration(), fixture.reservation(), protocol.configuration(), protocol.arm());
            var arm = store.inspect(fixture.binding().getBindingId());
            store.saveBound(fixture.binding(), fixture.registration(), fixture.reservation(), arm,
                    "aa36d481-0995-4060-8ce7-f3d42c3e408f", "a".repeat(64), "opaque:1", protocol.bound());
            var bound = store.inspect(fixture.binding().getBindingId());
            store.savePublication(fixture.binding(), fixture.registration(), fixture.reservation(), bound, protocol.publication());
            var restarted = new WorkspaceCsiNodeSourceStore(fixture.jdbc(), fixture.manager(), fixture.bindings())
                    .inspect(fixture.binding().getBindingId());
            assertThat(restarted.phase()).isEqualTo("PUBLISHED");
            assertThat(restarted.version()).isEqualTo(3);
            assertThat(restarted.configuration()).isEqualTo(protocol.configuration());
            assertThat(restarted.arm().bytes()).isEqualTo(protocol.arm().bytes());
            assertThat(restarted.bound().bytes()).isEqualTo(protocol.bound().bytes());
            assertThat(restarted.publication().bytes()).isEqualTo(protocol.publication().bytes());
            assertThatThrownBy(() -> store.saveBound(fixture.binding(), fixture.registration(), fixture.reservation(), arm,
                    "aa36d481-0995-4060-8ce7-f3d42c3e408f", "a".repeat(64), "opaque:1", protocol.bound()))
                    .hasMessageContaining("original CSI node source association");
            assertThat(store.inspect(fixture.binding().getBindingId()).publication().bytes()).isEqualTo(protocol.publication().bytes());
            assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_csi_source", Integer.class)).isEqualTo(1);
            assertThat(fixture.bindings().findById(fixture.binding().getBindingId()).getVersion()).isEqualTo(fixture.binding().getVersion());
        }
    }

    @Test
    void acceptsOriginalClaimRenewalAndRefusesReplacementWithoutAdvancing() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = fixture(database);
            var binding = fixture.binding();
            var store = fixture.store();
            var protocol = fixture.protocol();
            fixture.bindings().renewOperation(binding.getBindingId(), binding.getOperationOwner(),
                    binding.getOperationGeneration(), Duration.ofSeconds(120));
            store.saveArm(binding, fixture.registration(), fixture.reservation(), protocol.configuration(), protocol.arm());
            var saved = store.inspect(binding.getBindingId());
            fixture.bindings().releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
            var replacement = fixture.bindings().claimOperation(binding.getBindingId(), "replacement", Duration.ofSeconds(120));
            assertThat(replacement.getOperationGeneration()).isEqualTo(binding.getOperationGeneration() + 1);
            assertThatThrownBy(() -> store.saveBound(binding, fixture.registration(), fixture.reservation(), saved,
                    "aa36d481-0995-4060-8ce7-f3d42c3e408f", "a".repeat(64), "opaque:1", protocol.bound()))
                    .hasMessageContaining("original CSI node source association");
            var after = store.inspect(binding.getBindingId());
            assertThat(after.phase()).isEqualTo("ARMED");
            assertThat(after.version()).isEqualTo(1);
            assertThat(after.arm().bytes()).isEqualTo(saved.arm().bytes());
            assertThat(after.bound()).isNull();
            assertThat(after.publication()).isNull();
        }
    }

    private record Fixture(ManagedSchemaJdbcTemplate jdbc, DataSourceTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord binding, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, WorkspaceCsiNodeSourceStore store,
            WorkspaceCsiNodeSourceStoreTest.Protocol protocol) { }

    private static Fixture fixture(IsolatedManagedSchemaMySqlTestDatabase database) throws Exception {
        var source = database.source();
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var json = new ObjectMapper();
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc",
                "0c39f52b-120c-47fb-99bc-df907924af71", "pv", "3cfe8df0-ec94-465b-9e93-53c2491946a7",
                "diskplugin.csi.alibabacloud.com", "volume", "backend", "disk-serial", "/workspace", 7);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        reservations.register(registration);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'workspace', ?, 'OPERATOR')",
                ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        String session = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null, new WorkspaceSelection("workspace", "."))).sessionId();
        var managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        var request = new TransactionTemplate(manager).execute(status -> managed.requireCsiRequest(registration, session));
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        String reservationId = UUID.nameUUIDFromBytes(("qwen-csi-reservation/1:" + registration.aliasKey() + ":"
                + registration.revision() + ":" + binding.getProvisionSeed().getProvisionRequestId()).getBytes(StandardCharsets.UTF_8)).toString();
        var reservation = reservations.reserve(registration, bindings, binding, reservationId);
        return new Fixture(jdbc, manager, bindings, binding, registration, reservation,
                new WorkspaceCsiNodeSourceStore(jdbc, manager, bindings),
                WorkspaceCsiNodeSourceStoreTest.protocol(binding, registration, reservation));
    }
}
