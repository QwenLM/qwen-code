package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceCsiApplicationInventoryTest {
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private RuntimeBindingRecord binding;
    private WorkspaceCsiReservationStore.Retirement intent;
    private String session;

    @BeforeEach
    void setUp() {
        source = new DriverManagerDataSource("jdbc:h2:mem:application-inventory-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var json = new ObjectMapper();
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        reservations.register(registration);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        session = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        var managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        var transaction = new TransactionTemplate(manager);
        var request = transaction.execute(status -> managed.requireCsiRequest(registration, session));
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        var reservation = reservations.reserve(registration, bindings, binding, UUID.randomUUID().toString());
        var seed = binding.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("https://original.example.invalid"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = bindings.compareAndSet(binding, binding.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original")),
                Instant.now(), Instant.now()));
        intent = reservations.beginRetirement(registration, bindings, binding, reservation, UUID.randomUUID().toString());
    }

    @Test
    void inventoriesEveryDeclaredTableAndPreservesRealPrivateCreationFacts() throws Exception {
        var snapshot = inspect();
        assertThat(snapshot.tables()).hasSize(62);
        assertThat(snapshot.tables().stream().map(table -> table.columns().size()).mapToInt(Integer::intValue).sum()).isEqualTo(854);
        assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift")
                || blocker.code().equals("query_unavailable"));
        for (String table : new String[] {"managed_agent_session", "managed_workspace_create_command",
                "managed_session_create_scope", "managed_agent_event", "managed_agent_consumer_progress",
                "managed_workspace_csi_registration", "managed_workspace_csi_retirement",
                "managed_workspace_execution_lease", "qwen_runtime_binding", "qwen_runtime_binding_slot",
                "qwen_runtime_placement_guard", "qwen_tool_publication_tenant"}) {
            assertThat(snapshot.table(table).rows()).hasSize(1);
            assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals(table));
        }
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_journal_head")
                && blocker.code().equals("missing_or_extra_original"));
    }

    @Test
    void extraMissingAndChangedColumnTypesBlockEvenAnEmptyUnsupportedTable() throws Exception {
        jdbc.execute("ALTER TABLE managed_agent_action ADD COLUMN unexplained BIGINT");
        assertSchemaDrift();
        jdbc.execute("ALTER TABLE managed_agent_action DROP COLUMN unexplained");
        jdbc.execute("ALTER TABLE managed_agent_action ALTER COLUMN options_json BIGINT");
        assertSchemaDrift();
        jdbc.execute("ALTER TABLE managed_agent_action DROP COLUMN options_json");
        assertSchemaDrift();
    }

    @Test
    void taskJournalBooleanMetadataRetainsUnsupportedActivityAndExactValues() throws Exception {
        jdbc.execute("ALTER TABLE qwen_managed_session_task_journal ALTER COLUMN truncated BOOLEAN");
        jdbc.execute("ALTER TABLE qwen_managed_session_task_journal ALTER COLUMN archived BOOLEAN");
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.table().equals("qwen_managed_session_task_journal")
                && blocker.code().equals("schema_drift"));
        jdbc.update("INSERT INTO qwen_managed_session_task_journal (session_scope_key, tenant_id, session_id, task_id,"
                + " event_sequence, event_type, occurred_at, schema_version, projection_version, truncated, archived)"
                + " VALUES (?, 'tenant', ?, 'task', 1, 'output', 1, 1, 1, FALSE, TRUE)", sessionScope(), session);
        var observed = inspect();
        assertThat(observed.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_task_journal")
                && blocker.code().equals("unsupported_first_lane"));
        var row = observed.table("qwen_managed_session_task_journal").rows().getFirst();
        assertThat(row.bool("truncated")).isFalse();
        assertThat(row.bool("archived")).isTrue();
        var values = new java.util.LinkedHashMap<String, byte[]>();
        row.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        values.put("archived", "2".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow(
                "qwen_managed_session_task_journal", values, row.membership())).isInstanceOf(IllegalArgumentException.class);
        jdbc.execute("ALTER TABLE qwen_managed_session_task_journal ALTER COLUMN truncated VARCHAR(8)");
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_task_journal")
                && blocker.code().equals("schema_drift"));
    }

    @Test
    void aSqlFileHistoryExtensionIsBlockedWithoutBorrowingNativeProjectionSupport() throws Exception {
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                + " (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id,"
                + " operation_hash, revision, record_resource_id, created_at, first_sequence)"
                + " VALUES (?, ?, 'tenant', 'workspace', ?, 'file_history', 'history', ?, 1, 'resource', 1, 1)",
                sessionScope(), "a".repeat(64), session, "b".repeat(64));
        var snapshot = inspect();
        assertThat(snapshot.table("qwen_managed_session_extension_record").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_extension_record")
                && blocker.code().equals("unsupported_first_lane"));
    }

    @Test
    void independentlyRetainsAnOrphanRefAndAnUnreferencedPublishedResource() throws Exception {
        byte[] bytes = "{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                + " (session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, created_at)"
                + " VALUES (?, 'tenant', 'workspace', ?, 'extra', 'native-fixture', 1, ?, ?, 'MYSQL_INLINE', ?,"
                + " 'publish', 'PUBLISHED', CURRENT_TIMESTAMP(6))", sessionScope(), session, bytes.length, sha(bytes), bytes);
        jdbc.update("INSERT INTO qwen_managed_session_resource_ref"
                + " (session_scope_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, created_at)"
                + " VALUES (?, 'foreign', 'workspace', ?, 99, 'missing', CURRENT_TIMESTAMP(6))",
                sessionScope(), UUID.randomUUID().toString());
        var snapshot = inspect();
        assertThat(snapshot.table("qwen_managed_session_resource").rows()).hasSize(1);
        assertThat(snapshot.table("qwen_managed_session_resource_ref").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_resource_ref")
                && blocker.code().equals("invalid_original_association"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_resource"));
        assertThat(snapshot.table("qwen_managed_session_resource").rows().getFirst().binary("inline_bytes")).isEqualTo(bytes);
    }

    @Test
    void independentlyFindsCommandsAndDeliveriesWithNoScheduleClaimOrSessionColumn() throws Exception {
        jdbc.update("INSERT INTO qwen_managed_automation_command"
                + " (tenant_id, idempotency_key, actor_id, request_digest, schedule_id, result_json, created_at)"
                + " VALUES ('tenant', 'orphan', 'actor', 'digest', '', '{}', 1)");
        jdbc.update("INSERT INTO qwen_managed_automation_command"
                + " (tenant_id, idempotency_key, actor_id, request_digest, schedule_id, result_json, created_at)"
                + " VALUES ('foreign', 'original-json', 'actor', 'digest', 'unknown', ?, 1)",
                "{\"sessionId\":\"" + session + "\"}");
        jdbc.update("INSERT INTO qwen_managed_channel_delivery"
                + " (tenant_id, channel_instance_id, delivery_id, segment_id, segment_ordinal, state, created_at, updated_at)"
                + " VALUES ('tenant', 'channel', 'delivery', 'segment', 0, 'returned', 1, 1)");
        var snapshot = inspect();
        assertThat(snapshot.table("qwen_managed_automation_command").rows()).hasSize(2);
        assertThat(snapshot.table("qwen_managed_channel_delivery").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("unresolved_command_owner"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("unresolved_delivery_owner"));
    }

    @Test
    void fullTypedBytesAreStableImmutableAndIncludeEveryChangedField() throws Exception {
        var before = inspect();
        var replay = inspect();
        assertThat(replay.bytes()).isEqualTo(before.bytes());
        var parent = before.table("managed_agent_session").rows().getFirst();
        byte[] actor = parent.binary("creator_actor_key");
        actor[0] ^= 1;
        byte[] encoded = parent.bytes();
        encoded[0] ^= 1;
        byte[] snapshotBytes = before.bytes();
        snapshotBytes[0] ^= 1;
        assertThat(replay.bytes()).isEqualTo(before.bytes());
        assertThat(parent.binary("creator_actor_key")).isNotEqualTo(actor);
        assertThat(parent.bytes()).isNotEqualTo(encoded);
        jdbc.update("UPDATE managed_agent_session SET approval_mode = 'default' WHERE session_id = ?", session);
        var changed = inspect();
        assertThat(changed.bytes()).isNotEqualTo(before.bytes());
        assertThat(changed.table("managed_agent_session").rows().getFirst().text("approval_mode")).isEqualTo("default");
        assertThat(before.table("managed_agent_session").rows().getFirst().text("approval_mode")).isEqualTo("yolo");
    }

    @Test
    void aggregateRowOverflowCannotBeHiddenByUnsupportedOrRepeatedRows() throws Exception {
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                        + " VALUES ('tenant', ?, ?, 'COMPLETED', '{}', 1)")) {
            for (int index = 0; index <= WorkspaceCsiApplicationInventory.MAX_ROWS; index++) {
                statement.setString(1, session);
                statement.setString(2, String.format("%05d", index));
                statement.addBatch();
            }
            statement.executeBatch();
        }
        var snapshot = inspect();
        assertThat(snapshot.rowCount()).isLessThanOrEqualTo(WorkspaceCsiApplicationInventory.MAX_ROWS);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("row_limit"));
    }

    @Test
    void anOversizedBinaryColumnBlocksBeforeItCanBecomeACut() throws Exception {
        byte[] bytes = new byte[WorkspaceCsiApplicationInventory.MAX_BYTES + 1];
        jdbc.update("UPDATE managed_workspace_csi_retirement SET frozen_request_bytes = ?, frozen_request_sha256 = ?",
                bytes, sha(bytes));
        var snapshot = inspect();
        assertThat(snapshot.byteCount()).isLessThanOrEqualTo(WorkspaceCsiApplicationInventory.MAX_BYTES);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("byte_limit"));
    }

    @Test
    void nonzeroNativeHistoryExecutionsAndReadsRemainCompleteAcrossAllStates() throws Exception {
        byte[] resource = "{\"schemaVersion\":1,\"data\":\"complete bytes\"}".getBytes(StandardCharsets.UTF_8);
        byte[] record = "{\"sequence\":1,\"resourceId\":\"resource\"}\n".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO qwen_managed_session_journal_head (tenant_id, workspace_id, session_id, storage_version,"
                + " state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision,"
                + " committed_sequence, last_commit_digest, activation_epoch, compacted_through_revision, recovery_status,"
                + " created_at, updated_at, activation_id) VALUES ('tenant', 'workspace', ?, 1, 'ACTIVE', 1, 'writer',"
                + " CURRENT_TIMESTAMP, ?, 1, 1, ?, 1, 0, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'activation')",
                session, "a".repeat(64), "b".repeat(64));
        jdbc.update("INSERT INTO qwen_managed_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence,"
                + " event_count, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                + " record_encoding, record_bytes, byte_length, record_digest, created_at)"
                + " VALUES ('tenant', 'workspace', ?, 1, ?, 'transaction', 'fixture', 'command', ?, 1, 1, 1, ?, 1,"
                + " 'writer', ?, 1, 'identity', ?, ?, ?, CURRENT_TIMESTAMP)",
                session, "c".repeat(64), "d".repeat(64), "b".repeat(64), "a".repeat(64), record, record.length, sha(record));
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                + " state, created_at) VALUES (?, 'tenant', 'workspace', ?, 'resource', 'inventory-fixture', 1, ?, ?,"
                + " 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', CURRENT_TIMESTAMP)",
                sessionScope(), session, resource.length, sha(resource), resource);
        jdbc.update("INSERT INTO qwen_managed_session_resource_ref (session_scope_key, tenant_id, workspace_id, session_id,"
                + " journal_revision, resource_id, created_at) VALUES (?, 'tenant', 'workspace', ?, 1, 'resource', CURRENT_TIMESTAMP)",
                sessionScope(), session);
        for (String state : List.of("PREPARED", "DISPATCHING", "EXECUTING", "CANCEL_REQUESTED", "UNKNOWN", "ABANDONED", "SETTLED")) {
            insertExecution(state, state, binding.getBindingId(), session, brokerHash(session));
        }
        insertExecution("foreign", "SETTLED", "foreign-binding", "foreign-session", brokerHash(session));
        for (String state : List.of("OPEN", "UNKNOWN", "RETURNED")) {
            jdbc.update("INSERT INTO qwen_csi_resource_read (read_id, tenant_id, workspace_id, session_id, request_key, binding_id,"
                    + " runtime_generation, binding_version, writer_id, writer_generation, writer_token_hash, journal_revision,"
                    + " activation_id, activation_epoch, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                    + " resource_state, state, started_at, delivery_expires_at, ended_at, outcome_code)"
                    + " VALUES (?, 'tenant', 'workspace', ?, ?, ?, ?, 1, 'writer', 1, ?, 1, 'activation', 1, 'resource',"
                    + " 'inventory-fixture', 1, ?, ?, 'MYSQL_INLINE', 'REFERENCED', ?, 1, 3, ?, ?)",
                    state, session, binding.getRequest().requestKey(), binding.getBindingId(), binding.getGeneration(),
                    "a".repeat(64), resource.length, sha(resource), state, state.equals("RETURNED") ? 2L : null,
                    state.equals("RETURNED") ? "verified" : null);
        }
        var snapshot = inspect();
        for (String table : List.of("qwen_managed_session_journal_head", "qwen_managed_session_journal_tx",
                "qwen_managed_session_resource", "qwen_managed_session_resource_ref")) {
            assertThat(snapshot.table(table).rows()).hasSize(1);
            assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals(table));
        }
        assertThat(snapshot.table("qwen_managed_session_journal_tx").rows().getFirst().binary("record_bytes")).isEqualTo(record);
        assertThat(snapshot.table("qwen_managed_session_resource").rows().getFirst().binary("inline_bytes")).isEqualTo(resource);
        assertThat(snapshot.table("qwen_tool_execution").rows()).hasSize(8);
        assertThat(snapshot.table("qwen_csi_resource_read").rows()).hasSize(3);
        var settled = snapshot.table("qwen_tool_execution").rows().stream()
                .filter(row -> row.text("execution_call_id").equals("SETTLED")).findFirst().orElseThrow();
        assertThat(settled.fields()).hasSize(28);
        assertThat(settled.text("native_authorization_json")).isEqualTo("{}");
        assertThat(settled.key()).containsExactly(settled.cell("execution_call_id_hash"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_tool_execution"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_csi_resource_read"));
        assertThat(snapshot.rowCount()).isEqualTo(snapshot.tables().stream().mapToInt(table -> table.rows().size()).sum());
        assertThat(snapshot.byteCount()).isEqualTo(snapshot.tables().stream()
                .flatMap(table -> table.rows().stream()).mapToLong(row -> row.bytes().length).sum());
        assertThat(inspect().bytes()).isEqualTo(snapshot.bytes());
    }

    @Test
    void legacyNullProgressBlocksAndEveryProgressTailChangesTheCapturedBytes() throws Exception {
        var before = inspect();
        jdbc.update("UPDATE managed_workspace_csi_retirement SET progress_stage = NULL");
        var legacy = inspect();
        assertThat(legacy.blockers()).anyMatch(blocker -> blocker.table().equals("managed_workspace_csi_retirement")
                && blocker.code().equals("invalid_original_association"));
        assertThat(legacy.bytes()).isNotEqualTo(before.bytes());
        jdbc.update("UPDATE managed_workspace_csi_retirement SET progress_stage = 'FROZEN', progress_version = progress_version + 1,"
                + " frozen_request_bytes = ?, frozen_request_sha256 = ?", new byte[] {1, 2}, sha(new byte[] {1, 2}));
        var frozen = inspect();
        assertThat(frozen.bytes()).isNotEqualTo(legacy.bytes());
        assertThat(frozen.table("managed_workspace_csi_retirement").rows().getFirst().binary("frozen_request_bytes"))
                .isEqualTo(new byte[] {1, 2});
    }

    @Test
    void changedPhysicalRegistrationCannotHideBehindUnchangedAliasAndRevision() throws Exception {
        var saved = (com.fasterxml.jackson.databind.node.ObjectNode) new ObjectMapper().readTree(
                jdbc.queryForObject("SELECT registration_json FROM managed_workspace_csi_registration", String.class));
        saved.put("volumeHandle", "replacement");
        jdbc.update("UPDATE managed_workspace_csi_registration SET registration_json = ?", saved.toString());
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("managed_workspace_csi_registration")
                && blocker.code().equals("invalid_original_association"));
    }

    @Test
    void unrelatedGlobalDefinitionsAreNotOriginalWorkForTheOpaqueSelectedRevision() throws Exception {
        jdbc.update("INSERT INTO managed_agent_definition (tenant_id, agent_id, revision, digest, definition_json, created_at)"
                + " VALUES ('tenant', 'qwen-code', 7, 'digest', '{}', 1)");
        var snapshot = inspect();
        assertThat(snapshot.table("managed_agent_definition").rows()).isEmpty();
        assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals("managed_agent_definition"));
    }

    @Test
    void rowsUseTheWholeFinalPrimaryKeyAndSortNumericComponentsNumerically() throws Exception {
        for (long sequence : new long[] {10, 2}) {
            jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id, sequence_id, event_id, event_type, data_json,"
                    + " terminal, created_at) VALUES ('tenant', ?, ?, ?, 'fixture', '{}', FALSE, 1)",
                    session, sequence, UUID.randomUUID().toString());
        }
        var snapshot = inspect();
        var table = snapshot.table("managed_agent_event");
        assertThat(table.primaryKey()).containsExactly("tenant_id", "session_id", "sequence_id");
        assertThat(table.rows()).extracting(row -> row.number("sequence_id")).containsExactly(1L, 2L, 10L);
        for (var row : table.rows()) {
            assertThat(row.key()).containsExactly(row.cell("tenant_id"), row.cell("session_id"), row.cell("sequence_id"));
            assertThat(row.fields()).hasSize(table.columns().size());
        }
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("managed_agent_event"));
    }

    @Test
    void samePrimaryKeyWithChangedWholeBytesBlocksDuringTheFixedPoint() throws Exception {
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            var attempts = new AtomicInteger();
            var wrapped = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, arguments) -> {
                        if (method.getName().equals("prepareStatement") && arguments != null
                                && arguments[0] instanceof String sql && sql.startsWith("SELECT t.* FROM managed_agent_session t")
                                && attempts.incrementAndGet() == 2) {
                            try (var statement = target.prepareStatement("UPDATE managed_agent_session SET approval_mode = 'changed'")) {
                                statement.executeUpdate();
                            }
                        }
                        try {
                            return method.invoke(target, arguments);
                        } catch (InvocationTargetException exception) {
                            throw exception.getCause();
                        }
                    });
            try {
                var original = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                var snapshot = WorkspaceCsiApplicationInventory.inspect(wrapped, original, intent);
                assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("managed_agent_session")
                        && blocker.code().equals("same_key_conflicting_bytes"));
                assertThat(snapshot.table("managed_agent_session").rows()).hasSize(1);
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void persistedValueCodecRoundTripsWithoutTurningInspectionBlockersIntoAuthority() throws Exception {
        var observed = inspect();
        assertThat(observed.blockers()).isNotEmpty();
        var valueOnly = WorkspaceCsiApplicationInventory.expectedImage(observed.tables());
        var restored = WorkspaceCsiApplicationInventory.restoreCanonical(valueOnly.bytes());
        assertThat(restored.bytes()).isEqualTo(valueOnly.bytes());
        assertThat(restored.tables()).hasSize(62);
        assertThat(restored.rowCount()).isEqualTo(observed.rowCount());
        assertThat(observed.blockers()).isNotEmpty();
        byte[] trailing = java.util.Arrays.copyOf(valueOnly.bytes(), valueOnly.bytes().length + 1);
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.restoreCanonical(trailing)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.restoreCanonical(java.util.Arrays.copyOf(valueOnly.bytes(), valueOnly.bytes().length - 1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.restoreCanonical(observed.bytes())).isInstanceOf(IllegalArgumentException.class);
        var tables = new java.util.ArrayList<>(valueOnly.tables());
        var first = tables.getFirst();
        tables.set(0, new WorkspaceCsiApplicationInventory.Table("unreviewed", first.columns(), first.primaryKey(), first.rows()));
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedImage(tables)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void persistedRowsRefuseNoncanonicalTypesAndIncompleteFullKeys() throws Exception {
        var row = inspect().table("managed_agent_session").rows().getFirst();
        Map<String, byte[]> values = new java.util.LinkedHashMap<>();
        row.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        for (String invalid : List.of("01", "1.0", "+1", "9223372036854775808")) {
            var changed = new java.util.LinkedHashMap<>(values);
            changed.put("workspace_generation", invalid.getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("managed_agent_session", changed, row.membership()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        var changed = new java.util.LinkedHashMap<>(values);
        changed.put("csi_guard", "1".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("managed_agent_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.put("csi_guard", values.get("csi_guard"));
        changed.put("session_id", null);
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("managed_agent_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.put("session_id", new byte[] {(byte) 0xc3, 0x28});
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("managed_agent_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.remove("approval_mode");
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("managed_agent_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void frozenExpectedImageAllowsOnlyTheDeclaredProgressDelta() throws Exception {
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        byte[] frozen = "{\"saved\":true}".getBytes(StandardCharsets.UTF_8);
        var expected = WorkspaceCsiApplicationImage.expected(baseline,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.FROZEN, frozen, null, null);
        var progress = expected.table("managed_workspace_csi_retirement").rows().getFirst();
        assertThat(progress.text("progress_stage")).isEqualTo("FROZEN");
        assertThat(progress.number("progress_version")).isEqualTo(2);
        assertThat(progress.binary("frozen_request_bytes")).isEqualTo(frozen);
        assertThat(progress.text("frozen_request_sha256")).isEqualTo(sha(frozen));
        for (var table : baseline.tables()) {
            if (!table.name().equals("managed_workspace_csi_retirement")) {
                assertThat(expected.table(table.name()).rows().stream().map(WorkspaceCsiApplicationInventory.Row::bytes).toList())
                        .containsExactlyElementsOf(table.rows().stream().map(WorkspaceCsiApplicationInventory.Row::bytes).toList());
            }
        }
        jdbc.update("UPDATE managed_workspace_csi_retirement SET progress_stage = 'FROZEN', progress_version = 2,"
                + " frozen_request_bytes = ?, frozen_request_sha256 = ?", frozen, sha(frozen));
        var actual = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        WorkspaceCsiApplicationImage.verify(actual, expected);
        jdbc.update("UPDATE managed_agent_session SET updated_at = updated_at + 1");
        var drift = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.verify(drift, expected)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.expected(actual,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.FROZEN, frozen, null, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void ownershipProjectionChangesOnlyElevenCellsWithoutGrantingAuthority() throws Exception {
        var observed = inspect();
        assertThat(observed.blockers()).isNotEmpty();
        assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(observed)).isInstanceOf(IllegalArgumentException.class);
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(observed.tables());
        byte[] original = fixture.bytes();
        var projected = WorkspaceCsiPhysicalReleaseImage.expected(fixture);
        var allowed = Map.of("qwen_runtime_binding", java.util.Set.of("binding_state", "record_version"),
                "qwen_runtime_binding_slot", java.util.Set.of("active_binding_id"),
                "managed_workspace_execution_lease", java.util.Set.of("csi_phase", "csi_revision", "csi_reservation_id",
                        "csi_registration_key", "csi_registration_revision", "binding_id", "runtime_generation", "csi_provision_request_id"));
        int differences = 0;
        for (var table : fixture.tables()) {
            var actual = projected.table(table.name());
            assertThat(actual.columns()).isEqualTo(table.columns());
            assertThat(actual.primaryKey()).isEqualTo(table.primaryKey());
            assertThat(actual.rows()).hasSize(table.rows().size());
            for (int index = 0; index < table.rows().size(); index++) {
                var before = table.rows().get(index);
                var after = actual.rows().get(index);
                assertThat(after.key()).isEqualTo(before.key());
                assertThat(after.membership()).isEqualTo(before.membership());
                for (var field : before.fields().entrySet()) {
                    if (!field.getValue().equals(after.cell(field.getKey()))) {
                        assertThat(allowed.getOrDefault(table.name(), java.util.Set.of())).contains(field.getKey());
                        differences++;
                    }
                }
            }
        }
        assertThat(differences).isEqualTo(11);
        var changedBinding = WorkspaceCsiApplicationImage.sole(projected, "qwen_runtime_binding");
        assertThat(changedBinding.text("binding_state")).isEqualTo("RELEASED");
        assertThat(changedBinding.number("record_version")).isEqualTo(
                WorkspaceCsiApplicationImage.sole(fixture, "qwen_runtime_binding").number("record_version") + 1);
        assertThat(WorkspaceCsiApplicationImage.sole(projected, "qwen_runtime_binding_slot").cell("active_binding_id").isNull()).isTrue();
        var changedHolder = WorkspaceCsiApplicationImage.sole(projected, "managed_workspace_execution_lease");
        assertThat(changedHolder.text("csi_phase")).isEqualTo("RELEASED");
        assertThat(changedHolder.number("csi_revision")).isEqualTo(3);
        for (String field : List.of("csi_reservation_id", "csi_registration_key", "csi_registration_revision",
                "binding_id", "runtime_generation", "csi_provision_request_id")) {
            assertThat(changedHolder.cell(field).isNull()).isTrue();
        }
        assertThat(fixture.bytes()).isEqualTo(original);
        assertThat(WorkspaceCsiPhysicalReleaseImage.expected(fixture).bytes()).isEqualTo(projected.bytes());
        assertThat(inspect().bytes()).isEqualTo(observed.bytes());
        assertThat(observed.blockers()).isNotEmpty();
    }

    @Test
    void ownershipProjectionRefusesWrongPhaseIdentityAndLiveLogicalHolders() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        for (var fault : List.of(
                List.of("qwen_runtime_binding", "binding_state", "READY"),
                List.of("qwen_runtime_binding", "drain_requested", "false"),
                List.of("qwen_runtime_binding_slot", "active_binding_id", "foreign"),
                List.of("qwen_runtime_binding_slot", "last_generation", "2"),
                List.of("qwen_runtime_binding_slot", "request_key", "x"),
                List.of("qwen_runtime_binding_slot", "storage_id", "foreign"),
                List.of("managed_workspace_execution_lease", "binding_id", "foreign"),
                List.of("managed_workspace_execution_lease", "storage_kind", "LOCAL"),
                List.of("managed_workspace_execution_lease", "csi_phase", "RELEASED"),
                List.of("managed_workspace_execution_lease", "holder_key", "logical"),
                List.of("managed_workspace_execution_lease", "runtime_session_id", "logical"),
                List.of("managed_workspace_execution_lease", "maintenance_id", "maintenance"),
                List.of("managed_workspace_execution_lease", "csi_reservation_id", ""),
                List.of("managed_workspace_execution_lease", "csi_registration_revision", "0"))) {
            var invalid = ownershipCellFixture(fixture, fault.get(0), fault.get(1), fault.get(2));
            assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(invalid)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void ownershipProjectionUsesCheckedStoredCountersWithoutEnablingLaterCycles() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        for (long revision : new long[] {2, 5, 9_007_199_254_740_989L}) {
            var value = ownershipCellFixture(fixture, "managed_workspace_execution_lease", "csi_revision", Long.toString(revision));
            assertThat(WorkspaceCsiApplicationImage.sole(WorkspaceCsiPhysicalReleaseImage.expected(value),
                    "managed_workspace_execution_lease").number("csi_revision")).isEqualTo(revision + 1);
        }
        for (String invalid : new String[] {null, "-1", "0", "1", "3", "9007199254740990", "9007199254740992"}) {
            var value = ownershipCellFixture(fixture, "managed_workspace_execution_lease", "csi_revision", invalid);
            assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(value)).isInstanceOf(IllegalArgumentException.class);
        }
        for (String invalid : new String[] {null, "0", "-1"}) {
            var value = ownershipCellFixture(fixture, "qwen_runtime_binding", "record_version", invalid);
            assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(value)).isInstanceOf(IllegalArgumentException.class);
        }
        var exhausted = ownershipCellFixture(fixture, "qwen_runtime_binding", "record_version", Long.toString(Long.MAX_VALUE));
        assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(exhausted)).isInstanceOf(ArithmeticException.class);
    }

    @Test
    void ownershipProjectionRefusesMissingAndExtraOriginalRowsAndPreservesOtherMembership() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        for (String tableName : List.of("qwen_runtime_binding", "qwen_runtime_binding_slot", "managed_workspace_execution_lease")) {
            var table = fixture.table(tableName);
            var missingTables = new java.util.ArrayList<>(fixture.tables());
            missingTables.set(missingTables.indexOf(table), new WorkspaceCsiApplicationInventory.Table(
                    tableName, table.columns(), table.primaryKey(), List.of()));
            var missing = WorkspaceCsiApplicationInventory.expectedImage(missingTables);
            assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(missing)).isInstanceOf(IllegalArgumentException.class);
            var original = WorkspaceCsiApplicationImage.sole(fixture, tableName);
            var values = new java.util.LinkedHashMap<String, byte[]>();
            original.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
            values.put(table.primaryKey().getFirst(), "z".getBytes(StandardCharsets.UTF_8));
            for (var membership : WorkspaceCsiApplicationInventory.Membership.values()) {
                var extra = WorkspaceCsiApplicationInventory.expectedRow(tableName, values, membership);
                var rows = new java.util.ArrayList<>(table.rows());
                rows.add(extra);
                rows.sort(WorkspaceCsiApplicationInventory::compareKeys);
                var tables = new java.util.ArrayList<>(fixture.tables());
                tables.set(tables.indexOf(table), new WorkspaceCsiApplicationInventory.Table(tableName, table.columns(), table.primaryKey(), rows));
                var value = WorkspaceCsiApplicationInventory.expectedImage(tables);
                if (membership == WorkspaceCsiApplicationInventory.Membership.ORIGINAL) {
                    assertThatThrownBy(() -> WorkspaceCsiPhysicalReleaseImage.expected(value)).isInstanceOf(IllegalArgumentException.class);
                } else {
                    var projected = WorkspaceCsiPhysicalReleaseImage.expected(value);
                    var retained = projected.table(tableName).rows().stream().filter(row -> row.membership() == membership).findFirst().orElseThrow();
                    assertThat(retained.bytes()).isEqualTo(extra.bytes());
                    assertThat(retained.membership()).isEqualTo(extra.membership());
                }
            }
        }
    }

    @Test
    void historicalImagePreservesOriginalReleasedRowsWithoutTheSharedHolder() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var released = WorkspaceCsiPhysicalReleaseImage.expected(fixture);
        var history = WorkspaceCsiPhysicalHistoryImage.expected(fixture);
        assertThat(history.table("managed_workspace_execution_lease").rows()).isEmpty();
        assertThat(WorkspaceCsiApplicationImage.sole(history, "qwen_runtime_binding").text("binding_state")).isEqualTo("RELEASED");
        assertThat(WorkspaceCsiApplicationImage.sole(history, "qwen_runtime_binding_slot").cell("active_binding_id").isNull()).isTrue();
        for (var table : released.tables()) {
            if (table.name().equals("managed_workspace_execution_lease")) {
                continue;
            }
            var original = table.rows().stream().filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL).toList();
            var retained = history.table(table.name()).rows().stream()
                    .filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL).toList();
            assertThat(retained).hasSameSizeAs(original);
            for (int index = 0; index < original.size(); index++) {
                assertThat(retained.get(index).bytes()).isEqualTo(original.get(index).bytes());
            }
        }
        assertThat(history.table("managed_workspace_registry").rows()).hasSize(1);
        assertThat(history.table("managed_workspace_registry").rows().getFirst().cell("display_name").isNull()).isTrue();
        assertThat(history.table("managed_workspace_access").rows()).isEmpty();
        assertThat(fixture.table("managed_workspace_execution_lease").rows()).hasSize(1);
        assertThat(WorkspaceCsiApplicationImage.sole(fixture, "qwen_runtime_binding").text("binding_state")).isEqualTo("DRAINING");
    }

    @Test
    void historicalImagePinsOriginalBytesAndRequiredContextButExcludesDisplayAndHolderCells() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var expected = WorkspaceCsiPhysicalHistoryImage.expected(fixture).bytes();
        var changed = ownershipCellFixture(fixture, "managed_workspace_execution_lease", "mount_host_id", "later-host");
        assertThat(WorkspaceCsiPhysicalHistoryImage.expected(changed).bytes()).isEqualTo(expected);
        var tables = new java.util.ArrayList<>(fixture.tables());
        var registry = fixture.table("managed_workspace_registry");
        int registryIndex = tables.indexOf(registry);
        var row = registry.rows().getFirst();
        var values = new java.util.LinkedHashMap<String, byte[]>();
        row.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        values.put("display_name", "later-name".getBytes(StandardCharsets.UTF_8));
        var renamed = WorkspaceCsiApplicationInventory.expectedRow(registry.name(), values, row.membership());
        values.put("workspace_id", "unrelated-workspace".getBytes(StandardCharsets.UTF_8));
        var unrelated = WorkspaceCsiApplicationInventory.expectedRow(registry.name(), values, row.membership());
        var rows = new java.util.ArrayList<>(List.of(renamed, unrelated));
        rows.sort(WorkspaceCsiApplicationInventory::compareKeys);
        tables.set(registryIndex, new WorkspaceCsiApplicationInventory.Table(registry.name(), registry.columns(), registry.primaryKey(), rows));
        assertThat(WorkspaceCsiPhysicalHistoryImage.expected(WorkspaceCsiApplicationInventory.expectedImage(tables)).bytes()).isEqualTo(expected);
        changed = ownershipCellFixture(fixture, "managed_agent_session", "title", "changed-original");
        assertThat(WorkspaceCsiPhysicalHistoryImage.expected(changed).bytes()).isNotEqualTo(expected);
        values.put("workspace_id", row.text("workspace_id").getBytes(StandardCharsets.UTF_8));
        values.put("policy_ref", "changed-policy".getBytes(StandardCharsets.UTF_8));
        tables.set(registryIndex,
                new WorkspaceCsiApplicationInventory.Table(registry.name(), registry.columns(), registry.primaryKey(),
                        List.of(WorkspaceCsiApplicationInventory.expectedRow(registry.name(), values, row.membership()))));
        var invalid = WorkspaceCsiApplicationInventory.expectedImage(tables);
        assertThatThrownBy(() -> WorkspaceCsiPhysicalHistoryImage.expected(invalid)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void historicalImageRefusesMissingRequiredContextOrForgedMembership() throws Exception {
        var fixture = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        for (String name : List.of("managed_workspace_registry", "qwen_runtime_placement_guard", "qwen_tool_publication_tenant")) {
            var table = fixture.table(name);
            var tables = new java.util.ArrayList<>(fixture.tables());
            int tableIndex = tables.indexOf(table);
            tables.set(tableIndex, new WorkspaceCsiApplicationInventory.Table(name, table.columns(), table.primaryKey(), List.of()));
            var missing = WorkspaceCsiApplicationInventory.expectedImage(tables);
            assertThatThrownBy(() -> WorkspaceCsiPhysicalHistoryImage.expected(missing)).isInstanceOf(IllegalArgumentException.class);
            var row = table.rows().getFirst();
            var values = new java.util.LinkedHashMap<String, byte[]>();
            row.fields().forEach((field, cell) -> values.put(field, cell.bytes()));
            tables.set(tableIndex,
                    new WorkspaceCsiApplicationInventory.Table(name, table.columns(), table.primaryKey(),
                            List.of(WorkspaceCsiApplicationInventory.expectedRow(name, values, WorkspaceCsiApplicationInventory.Membership.OTHER))));
            var forged = WorkspaceCsiApplicationInventory.expectedImage(tables);
            assertThatThrownBy(() -> WorkspaceCsiPhysicalHistoryImage.expected(forged)).isInstanceOf(IllegalArgumentException.class);
            if (row.cell("tenant_key") != null) {
                values.put("tenant_key", "e".repeat(64).getBytes(StandardCharsets.UTF_8));
                tables.set(tableIndex, new WorkspaceCsiApplicationInventory.Table(name, table.columns(), table.primaryKey(),
                        List.of(WorkspaceCsiApplicationInventory.expectedRow(name, values, row.membership()))));
                var wrongKey = WorkspaceCsiApplicationInventory.expectedImage(tables);
                assertThatThrownBy(() -> WorkspaceCsiPhysicalHistoryImage.expected(wrongKey)).isInstanceOf(IllegalArgumentException.class);
            }
        }
    }

    private static WorkspaceCsiApplicationInventory.Snapshot ownershipCellFixture(
            WorkspaceCsiApplicationInventory.Snapshot fixture, String tableName, String field, String value) {
        var table = fixture.table(tableName);
        var original = WorkspaceCsiApplicationImage.sole(fixture, tableName);
        var values = new java.util.LinkedHashMap<String, byte[]>();
        original.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        values.put(field, value == null ? null : value.getBytes(StandardCharsets.UTF_8));
        var rows = new java.util.ArrayList<>(table.rows());
        rows.set(rows.indexOf(original), WorkspaceCsiApplicationInventory.expectedRow(tableName, values, original.membership()));
        var tables = new java.util.ArrayList<>(fixture.tables());
        tables.set(tables.indexOf(table), new WorkspaceCsiApplicationInventory.Table(tableName, table.columns(), table.primaryKey(), rows));
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private void insertExecution(String id, String state, String bindingId, String runtimeSession, String runtimeKey) {
        jdbc.update("INSERT INTO qwen_tool_execution (execution_call_id_hash, execution_call_id, idempotency_key_hash, idempotency_key,"
                + " binding_id, runtime_generation, harness_session_id, runtime_session_id, runtime_session_key, turn_id, tool_call_id,"
                + " request_digest, reference_json, execution_state, execution_status, result_json, last_sequence, cancel_requested,"
                + " dispatch_generation, record_version, settled_at, native_authorization_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                + " 'turn', 'call', 'digest', '{}', ?, 'success', '{}', 1, FALSE, 1, 1, CURRENT_TIMESTAMP, '{}')",
                brokerHash(id), id, brokerHash("idempotency-" + id), "idempotency-" + id, bindingId, binding.getGeneration(),
                runtimeSession, runtimeSession, runtimeKey, state);
    }

    private static String brokerHash(String text) {
        byte[] value = text.getBytes(StandardCharsets.UTF_8);
        return sha(java.nio.ByteBuffer.allocate(Integer.BYTES + value.length).putInt(value.length).put(value).array());
    }

    private void assertSchemaDrift() throws Exception {
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("managed_agent_action")
                && blocker.code().equals("schema_drift"));
    }

    private WorkspaceCsiApplicationInventory.Snapshot inspect() throws Exception {
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try {
                var original = JdbcCsiFilesRetirementGuard.lockBindingControl(connection, binding.getBindingId());
                return WorkspaceCsiApplicationInventory.inspect(connection, original, intent);
            } finally {
                connection.rollback();
            }
        }
    }

    private String sessionScope() {
        return sha(("tenant\u0000" + session).getBytes(StandardCharsets.UTF_8));
    }

    private static String sha(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }
}
