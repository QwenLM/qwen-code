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
    void typedHistoricalOwnerReadsOnlyItsRealRetainedRowsAndRefusesMissingKeys() throws Exception {
        var expected = inspect();
        var queries = new java.util.ArrayList<String>();
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var observed = observedRead(target, queries);
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(observed, intent.operationId(), System.nanoTime());
                assertThat(owner.binding().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(expected, "qwen_runtime_binding").bytes());
                assertThat(owner.retirement().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(expected,
                        "managed_workspace_csi_retirement").bytes());
                assertThat(queries).hasSize(2);
                assertThat(queries.get(0)).contains("FROM managed_workspace_csi_retirement t WHERE retirement_id = ?");
                assertThat(queries.get(1)).contains("FROM qwen_runtime_binding t WHERE binding_id = ?");
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(observed,
                        UUID.randomUUID().toString(), System.nanoTime())).isInstanceOf(IllegalArgumentException.class);
                int before = queries.size();
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(observed, intent.operationId(),
                        System.nanoTime() - java.util.concurrent.TimeUnit.SECONDS.toNanos(11)))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThat(queries).hasSize(before);
            } finally {
                target.rollback();
            }
        }
        jdbc.update("DELETE FROM qwen_runtime_binding WHERE binding_id = ?", binding.getBindingId());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(observedRead(target, queries),
                        intent.operationId(), System.nanoTime())).isInstanceOf(IllegalArgumentException.class);
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void historicalOwnerAndCandidateAuditShareUniqueWholeRowAccounting() throws Exception {
        var expected = historicalKeys();
        var control = readKeys(expected, new java.util.ArrayList<>());
        var queries = new java.util.ArrayList<String>();
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime());
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(read, intent.operationId());
                WorkspaceCsiApplicationInventory.readHistoricalOwner(read, intent.operationId());
                var current = WorkspaceCsiApplicationInventory.historicalScan(read, expected, Map.of());
                assertThat(current.blockers()).isEmpty();
                assertThat(current.bytes()).isEqualTo(control.bytes());
                assertThat(current.rowCount()).isEqualTo(control.rowCount());
                assertThat(current.byteCount()).isEqualTo(control.byteCount());
                assertThat(owner.binding().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(current, "qwen_runtime_binding").bytes());
                int closingQueries = queries.size();
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(read, intent.operationId()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.historicalScan(read, expected, Map.of()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThat(queries).hasSize(closingQueries);
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void historicalScanRetainsOwnerBudgetAndDetectsChangedDuplicateRows() throws Exception {
        var expected = historicalKeys();
        var empty = WorkspaceCsiApplicationInventory.expectedImage(expected.tables().stream().map(table ->
                new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(), List.of())).toList());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var observed = observedRead(target, new java.util.ArrayList<>());
                var budget = new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime());
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(budget, intent.operationId());
                var result = WorkspaceCsiApplicationInventory.historicalScan(budget, empty, Map.of());
                assertThat(result.rowCount()).isEqualTo(2);
                assertThat(result.byteCount()).isEqualTo(owner.binding().bytes().length + owner.retirement().bytes().length);
                var changed = new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime());
                WorkspaceCsiApplicationInventory.readHistoricalOwner(changed, intent.operationId());
                // Inject a same-snapshot owned-row fault through the underlying H2 connection only.
                try (var statement = target.prepareStatement("UPDATE qwen_runtime_binding SET record_version = record_version + 1 WHERE binding_id = ?")) {
                    statement.setString(1, binding.getBindingId());
                    assertThat(statement.executeUpdate()).isEqualTo(1);
                }
                var refused = WorkspaceCsiApplicationInventory.historicalScan(changed, expected, Map.of());
                assertThat(refused.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_runtime_binding")
                        && blocker.code().equals("historical_candidate_changed"));
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void historicalExecutionDecoderUsesRealBoundedRowsAndRejectsHashOrJsonAmbiguity() throws Exception {
        String id = UUID.randomUUID().toString();
        String reference = new ObjectMapper().writeValueAsString(Map.of("sessionId", session, "promptId", "turn",
                "callId", "call", "argsDigest", "digest", "dispatchMode", "deferred"));
        insertExecution(id, "SETTLED", binding.getBindingId(), session, brokerHash(session));
        jdbc.update("UPDATE qwen_tool_execution SET reference_json = ?, result_json = ? WHERE execution_call_id = ?",
                reference, "{\"executionStatus\":\"success\"}", id);
        var expected = historicalKeys();
        var control = readKeys(expected, new java.util.ArrayList<>());
        var original = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), 1,
                binding.getState(), binding.isDrainRequested(), binding.getVersion(), null);
        var queries = new java.util.ArrayList<String>();
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime());
                WorkspaceCsiApplicationInventory.readHistoricalOwner(read, intent.operationId());
                var decoded = read.originalExecutions(original);
                assertThat(decoded).hasSize(1);
                assertThat(decoded.getFirst().getExecutionCallId()).isEqualTo(id);
                assertThat(decoded.getFirst().getResult()).containsEntry("executionStatus", "success");
                assertThat(read.originalExecutions(original).getFirst()).isSameAs(decoded.getFirst());
                var current = WorkspaceCsiApplicationInventory.historicalScan(read, expected, Map.of());
                assertThat(current.blockers()).isEmpty();
                assertThat(current.rowCount()).isEqualTo(control.rowCount());
                assertThat(current.byteCount()).isEqualTo(control.byteCount());
                assertThat(current.bytes()).isEqualTo(control.bytes());
                assertThat(queries).anyMatch(sql -> sql.contains("binding_id = ? OR harness_session_id = ? OR runtime_session_id = ?"));
            } finally {
                target.rollback();
            }
        }
        for (var fault : List.of(Map.of("execution_call_id_hash", "b".repeat(64)),
                Map.of("reference_json", reference.substring(0, reference.length() - 1) + ",\"sessionId\":\"" + session + "\"}"),
                Map.of("result_json", "{\"executionStatus\":\"success\",\"executionStatus\":\"success\"}"))) {
            var field = fault.entrySet().iterator().next();
            jdbc.update("UPDATE qwen_tool_execution SET " + field.getKey() + " = ? WHERE execution_call_id = ?", field.getValue(), id);
            try (var target = source.getConnection()) {
                target.setAutoCommit(false);
                target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
                try {
                    var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime());
                    assertThatThrownBy(() -> read.originalExecutions(original)).isInstanceOf(IllegalArgumentException.class);
                } finally {
                    target.rollback();
                }
            }
            jdbc.update("UPDATE qwen_tool_execution SET execution_call_id_hash = ?, reference_json = ?, result_json = ? WHERE execution_call_id = ?",
                    brokerHash(id), reference, "{\"executionStatus\":\"success\"}", id);
        }
    }

    @Test
    void foreignOwnerProjectionRetainsItsWholeHolderWithoutChangingTheSavedCodec() throws Exception {
        var image = inspect();
        var owner = WorkspaceCsiPhysicalHistoryImage.owner(image);
        assertThat(owner.tables()).hasSize(image.tables().size());
        assertThat(owner.table("managed_workspace_execution_lease").rows()).hasSize(1);
        assertThat(owner.table("managed_workspace_execution_lease").rows().getFirst().bytes())
                .isEqualTo(WorkspaceCsiApplicationImage.sole(image, "managed_workspace_execution_lease").bytes());
        assertThat(owner.tables().stream().flatMap(table -> table.rows().stream()))
                .noneMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER);
        assertThat(owner.table("managed_workspace_registry").rows().getFirst().text("display_name")).isNull();
        assertThat(WorkspaceCsiApplicationInventory.restoreCanonical(owner.bytes()).bytes()).isEqualTo(owner.bytes());
    }

    @Test
    void foreignOwnerAuditUsesLocalStrongRootsAndNeverReopensTheParentCarrierScan() throws Exception {
        var owner = WorkspaceCsiPhysicalHistoryImage.owner(inspect());
        var empty = WorkspaceCsiApplicationInventory.expectedImage(owner.tables().stream().map(table ->
                new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(), List.of())).toList());
        var original = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), 1,
                binding.getState(), binding.isDrainRequested(), binding.getVersion(), null);
        var calls = new AtomicInteger();
        var queries = new java.util.ArrayList<String>();
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                // This explicit hook tests the narrow SQL component, not a validated frozen owner.
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime(),
                        (scan, carrier) -> { calls.incrementAndGet(); throw new AssertionError("Nested carrier scan"); });
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.auditForeignOwner(read, owner, original, intent))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThat(queries).isEmpty();
                WorkspaceCsiApplicationInventory.historicalScan(read, empty, Map.of());
                var retained = WorkspaceCsiApplicationInventory.readForeignOwner(read,
                        WorkspaceCsiApplicationImage.sole(owner, "managed_workspace_csi_retirement"));
                assertThat(retained.binding().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(owner, "qwen_runtime_binding").bytes());
                WorkspaceCsiApplicationInventory.auditForeignOwner(read, owner, original, intent);
                WorkspaceCsiApplicationInventory.requireForeignPhysicalAbsent(read, intent.operationId(), binding.getBindingId(), intent.physicalKey());
                assertThat(read.foreignExecutions(original)).isEmpty();
                assertThat(calls.get()).isZero();
                assertThat(queries).noneMatch(sql -> sql.contains("FOR UPDATE"));
                assertThat(queries).anyMatch(sql -> sql.contains("FROM managed_workspace_csi_physical t WHERE retirement_id = ? OR binding_id = ? OR physical_key = ?"));
                int before = queries.size();
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.historicalScan(read, empty, Map.of()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> read.originalExecutions(original)).isInstanceOf(IllegalArgumentException.class);
                assertThat(queries).hasSize(before);
                // Fault injection is explicitly on the owned H2 connection, outside the read facade.
                try (var statement = target.prepareStatement("INSERT INTO managed_agent_action"
                        + " (tenant_id,session_id,action_id,state,options_json,created_at) VALUES ('shadow',?,'extra','COMPLETED','{}',1)")) {
                    statement.setString(1, session);
                    assertThat(statement.executeUpdate()).isEqualTo(1);
                }
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.auditForeignOwner(read, owner, original, intent))
                        .isInstanceOf(IllegalArgumentException.class);
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void foreignPhysicalAbsenceRequiresTheExactCompanionSchemaAndIncludesSharedDomainRows() throws Exception {
        var owner = WorkspaceCsiPhysicalHistoryImage.owner(inspect());
        var empty = WorkspaceCsiApplicationInventory.expectedImage(owner.tables().stream().map(table ->
                new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(), List.of())).toList());
        for (String relation : List.of("retirement", "binding", "physical")) {
            jdbc.update("DELETE FROM managed_workspace_csi_physical");
            jdbc.update("INSERT INTO managed_workspace_csi_physical"
                    + " (retirement_id,binding_id,physical_key,record_version,record_bytes,record_sha256) VALUES (?,?,?,1,?,?)",
                    relation.equals("retirement") ? intent.operationId() : UUID.randomUUID().toString(),
                    relation.equals("binding") ? binding.getBindingId() : "foreign-binding",
                    relation.equals("physical") ? intent.physicalKey() : "f".repeat(64), new byte[] {1}, "a".repeat(64));
            try (var target = source.getConnection()) {
                target.setAutoCommit(false);
                target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
                try {
                    var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, new java.util.ArrayList<>()),
                            System.nanoTime(), (scan, carrier) -> { throw new AssertionError("Unexpected carrier"); });
                    WorkspaceCsiApplicationInventory.historicalScan(read, empty, Map.of());
                    assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.requireForeignPhysicalAbsent(read,
                            intent.operationId(), binding.getBindingId(), intent.physicalKey())).isInstanceOf(IllegalArgumentException.class);
                } finally {
                    target.rollback();
                }
            }
        }
        jdbc.update("DELETE FROM managed_workspace_csi_physical");
        jdbc.execute("ALTER TABLE managed_workspace_csi_physical ADD unexpected VARCHAR(10)");
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, new java.util.ArrayList<>()),
                        System.nanoTime(), (scan, carrier) -> { throw new AssertionError("Unexpected carrier"); });
                WorkspaceCsiApplicationInventory.historicalScan(read, empty, Map.of());
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.requireForeignPhysicalAbsent(read,
                        intent.operationId(), binding.getBindingId(), intent.physicalKey())).isInstanceOf(IllegalArgumentException.class);
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void plannedCompanionDataReaderPinsExactPlanBytesAndRejectsParentReferencesOrProgress() throws Exception {
        var expected = historicalKeys();
        String retirement = UUID.randomUUID().toString();
        String bindingId = "foreign-plan-binding";
        String physical = "e".repeat(64);
        String plan = "{\"format\":\"qwen-csi-physical-plan/3\",\"retirementId\":\"" + retirement
                + "\",\"bindingId\":\"" + bindingId + "\",\"physicalKey\":\"" + physical + "\"}";
        var expectedPlan = new ObjectMapper().readTree(plan);
        var sourceFixture = physicalFixture(plan.getBytes(StandardCharsets.UTF_8));
        byte[] control = plannedData(plan, retirement, bindingId, physical);
        var records = new java.util.ArrayList<byte[]>();
        records.add(control);
        records.add(plannedData(" " + plan, retirement, bindingId, physical));
        records.add(plannedData(plan, UUID.randomUUID().toString(), bindingId, physical));
        records.add(plannedData(plan, retirement, "other", physical));
        records.add(plannedData(plan, retirement, bindingId, "f".repeat(64)));
        records.add(new String(control, StandardCharsets.UTF_8).replace("\"stage\":\"PLANNED\"", "\"stage\":\"UNPUBLISHED\"")
                .getBytes(StandardCharsets.UTF_8));
        records.add(new String(control, StandardCharsets.UTF_8).replace("\"attempts\":[]", "\"attempts\":[{}]")
                .getBytes(StandardCharsets.UTF_8));
        records.add(new String(control, StandardCharsets.UTF_8).replace("\"observations\":[]", "\"observations\":[{}]")
                .getBytes(StandardCharsets.UTF_8));
        records.add(new String(control, StandardCharsets.UTF_8).replace("\"intent\":null", "\"intent\":{}")
                .getBytes(StandardCharsets.UTF_8));
        records.add((new String(control, StandardCharsets.UTF_8).substring(0, control.length - 1) + ",\"extra\":null}")
                .getBytes(StandardCharsets.UTF_8));
        for (int index = 0; index < records.size(); index++) {
            jdbc.update("DELETE FROM managed_workspace_csi_physical");
            byte[] raw = records.get(index);
            jdbc.update("INSERT INTO managed_workspace_csi_physical"
                    + " (retirement_id,binding_id,physical_key,record_version,record_bytes,record_sha256) VALUES (?,?,?,1,?,?)",
                    retirement, bindingId, physical, raw, sha(raw));
            try (var target = source.getConnection()) {
                target.setAutoCommit(false);
                target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
                try {
                    // The supplied minimal plan is an explicit SQL/codec seam, not a reconstructed actual owner plan.
                    var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, new java.util.ArrayList<>()),
                            System.nanoTime(), (scan, carrier) -> { throw new AssertionError("Unexpected carrier"); });
                    WorkspaceCsiApplicationInventory.historicalScan(read, expected, Map.of("session", java.util.Set.of("old-session")));
                    var row = WorkspaceCsiApplicationInventory.readForeignPhysical(read, retirement, bindingId, physical).getFirst();
                    if (index == 0) {
                        WorkspaceCsiApplicationInventory.verifyForeignProgress(read, row, expectedPlan, sourceFixture.source());
                        var poisoned = ((com.fasterxml.jackson.databind.node.ObjectNode) expectedPlan).deepCopy().put("sessionId", "old-session");
                        byte[] poisonedRaw = plannedData(poisoned.toString(), retirement, bindingId, physical);
                        try (var statement = target.prepareStatement("UPDATE managed_workspace_csi_physical SET record_bytes=?,record_sha256=? WHERE retirement_id=?")) {
                            statement.setBytes(1, poisonedRaw);
                            statement.setString(2, sha(poisonedRaw));
                            statement.setString(3, retirement);
                            assertThat(statement.executeUpdate()).isEqualTo(1);
                        }
                        var fresh = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, new java.util.ArrayList<>()),
                                System.nanoTime(), (scan, carrier) -> { throw new AssertionError("Unexpected carrier"); });
                        WorkspaceCsiApplicationInventory.historicalScan(fresh, expected, Map.of("session", java.util.Set.of("old-session")));
                        var poisonedRow = WorkspaceCsiApplicationInventory.readForeignPhysical(fresh, retirement, bindingId, physical).getFirst();
                        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.verifyForeignProgress(fresh, poisonedRow, poisoned, sourceFixture.source()))
                                .isInstanceOf(IllegalArgumentException.class);
                    } else {
                        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.verifyForeignProgress(read, row, expectedPlan, sourceFixture.source()))
                                .isInstanceOf(IllegalArgumentException.class);
                    }
                } finally {
                    target.rollback();
                }
            }
        }
    }

    private static byte[] plannedData(String plan, String retirement, String binding, String physical) {
        byte[] raw = plan.getBytes(StandardCharsets.UTF_8);
        return ("{\"format\":\"qwen-csi-physical-progress/1\",\"retirementId\":\"" + retirement + "\",\"bindingId\":\"" + binding
                + "\",\"physicalKey\":\"" + physical + "\",\"stage\":\"PLANNED\",\"planBase64\":\""
                + java.util.Base64.getEncoder().encodeToString(raw) + "\",\"planSha256\":\"" + sha(raw)
                + "\",\"intent\":null,\"attempts\":[],\"observations\":[]}").getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void progressedForeignCompanionChecksDecodedRepliesAndSourceAgainstFixedParentRoots() throws Exception {
        var json = new ObjectMapper();
        var expectedPlan = json.createObjectNode().put("format", "qwen-csi-physical-plan/3")
                .put("retirementId", UUID.randomUUID().toString()).put("bindingId", "foreign-progress-binding")
                .put("physicalKey", "e".repeat(64)).put("namespace", "lab-ns").put("podName", "lab-runtime")
                .put("podUid", "aa36d481-0995-4060-8ce7-f3d42c3e408f");
        byte[] plan = json.writeValueAsBytes(expectedPlan);
        var fixture = physicalFixture(plan);
        var original = fixture.source();
        var planned = WorkspaceCsiPhysicalProgress.planned(plan);
        var intentProgress = planned.withIntent(fixture.evidence(), original);
        var request = com.alibaba.qwen.code.runtimebroker.CsiPodDeletion.prepare("lab-ns", "lab-runtime", original.podUid(), "opaque:315");
        var pending = intentProgress.withAttempt(request);
        var reply = org.mockito.Mockito.mock(com.alibaba.qwen.code.runtimebroker.CsiPodDeletion.Result.class);
        org.mockito.Mockito.when(reply.request()).thenReturn(request);
        org.mockito.Mockito.when(reply.statusCode()).thenReturn(409);
        org.mockito.Mockito.when(reply.responseBytes()).thenReturn("{\"kind\":\"Status\",\"reason\":\"Conflict\"}".getBytes(StandardCharsets.UTF_8));
        var replied = pending.withReply(1, reply);
        var stoppedProgress = replied.withObservation(fixture.stopped(), original);
        var unpublishedProgress = stoppedProgress.withObservation(fixture.evidence(), original);
        var references = Map.of("session", java.util.Set.of("parent-session"), "binding", java.util.Set.of("parent-binding"));
        for (var progress : List.of(planned, intentProgress, pending, replied, stoppedProgress, unpublishedProgress)) {
            verifyPhysicalData(progress, expectedPlan, original, references);
        }
        assertThat(intentProgress.stage()).isEqualTo("INTENT");
        assertThat(stoppedProgress.stage()).isEqualTo("STOPPED");
        assertThat(unpublishedProgress.stage()).isEqualTo("UNPUBLISHED");
        for (byte[] response : List.of("{\"bindingId\":\"parent-binding\"}".getBytes(StandardCharsets.UTF_8),
                "{\"nested\":{\"sessionId\":\"parent-session\"}}".getBytes(StandardCharsets.UTF_8),
                "{\"kind\":\"Status\",\"kind\":\"Pod\"}".getBytes(StandardCharsets.UTF_8),
                "[]".getBytes(StandardCharsets.UTF_8), "{} {}".getBytes(StandardCharsets.UTF_8), new byte[] {(byte) 0xff})) {
            org.mockito.Mockito.when(reply.responseBytes()).thenReturn(response);
            var altered = pending.withReply(1, reply);
            assertThatThrownBy(() -> verifyPhysicalData(altered, expectedPlan, original, references)).isInstanceOf(IllegalArgumentException.class);
        }
        org.mockito.Mockito.when(reply.responseBytes()).thenReturn(new byte[0]);
        verifyPhysicalData(pending.withReply(1, reply), expectedPlan, original, references);
        assertThatThrownBy(() -> verifyPhysicalData(intentProgress, expectedPlan, original,
                Map.of("binding", java.util.Set.of(original.bindingId())))).isInstanceOf(IllegalArgumentException.class);
        var nextArm = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(json.writeValueAsBytes(
                fixture.evidence().record(original.arm().stream().observations().getFirst().arm())));
        ((com.fasterxml.jackson.databind.node.ObjectNode) nextArm.path("scope")).put("armId", "later-arm").put("bindingId", "later-binding");
        nextArm.put("sequence", 11).put("previous", fixture.evidence().stream().head().hash());
        nextArm.remove("hash");
        nextArm.put("hash", sha(json.writeValueAsBytes(nextArm)));
        var futureBytes = new java.io.ByteArrayOutputStream();
        futureBytes.write(fixture.evidence().bytes());
        var futureOutput = new java.io.DataOutputStream(futureBytes);
        byte[] nextRaw = json.writeValueAsBytes(nextArm);
        futureOutput.writeInt(nextRaw.length);
        futureOutput.write(nextRaw);
        var future = com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.verify(futureBytes.toByteArray(),
                new com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Cursor(11, nextArm.path("hash").textValue()));
        var futureProgress = replied.withObservation(future, original);
        assertThat(futureProgress.stage()).isEqualTo("UNPUBLISHED");
        assertThatThrownBy(() -> verifyPhysicalData(futureProgress, expectedPlan, original, references)).isInstanceOf(IllegalArgumentException.class);
        assertThat(references).isEqualTo(Map.of("session", java.util.Set.of("parent-session"), "binding", java.util.Set.of("parent-binding")));
    }

    private void verifyPhysicalData(WorkspaceCsiPhysicalProgress progress, com.fasterxml.jackson.databind.JsonNode plan,
            WorkspaceCsiNodeSourceStore.Association association, Map<String, java.util.Set<String>> references) throws Exception {
        jdbc.update("DELETE FROM managed_workspace_csi_physical");
        jdbc.update("INSERT INTO managed_workspace_csi_physical VALUES (?,?,?,?,?,?)", progress.retirementId(), progress.bindingId(),
                progress.physicalKey(), progress.version(), progress.bytes(), progress.sha256());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, new java.util.ArrayList<>()), System.nanoTime(),
                        (scan, carrier) -> { throw new AssertionError("This data test does not prove a complete owner"); });
                var expected = historicalKeys();
                WorkspaceCsiApplicationInventory.historicalScan(read, expected, references);
                var row = WorkspaceCsiApplicationInventory.readForeignPhysical(read, progress.retirementId(), progress.bindingId(), progress.physicalKey()).getFirst();
                WorkspaceCsiApplicationInventory.verifyForeignProgress(read, row, plan, association);
                assertThat(expected.bytes()).isEqualTo(historicalKeys().bytes());
            } finally {
                target.rollback();
            }
        }
    }

    private record PhysicalFixture(WorkspaceCsiNodeSourceStore.Association source,
            com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Evidence stopped,
            com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Evidence evidence) { }

    private PhysicalFixture physicalFixture(byte[] plan) throws Exception {
        var json = new ObjectMapper();
        var identity = json.readTree(plan);
        byte[] raw;
        try (var input = getClass().getResourceAsStream("/contracts/k2-node-source-v4.fixture.json")) {
            assertThat(input).isNotNull();
            raw = java.util.Base64.getDecoder().decode(json.readTree(input).path("bytesBase64").textValue());
        }
        var input = java.nio.ByteBuffer.wrap(raw);
        var frames = new java.util.ArrayList<com.fasterxml.jackson.databind.node.ObjectNode>();
        var hashes = new java.util.HashMap<Long, String>();
        String previous = "0".repeat(64);
        while (input.hasRemaining()) {
            byte[] frame = new byte[input.getInt()];
            input.get(frame);
            var record = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(frame);
            if (record.has("scope")) {
                var scope = (com.fasterxml.jackson.databind.node.ObjectNode) record.path("scope");
                scope.put("bindingId", identity.path("bindingId").textValue());
                if (!scope.path("retirementId").textValue().isEmpty()) {
                    scope.put("retirementId", identity.path("retirementId").textValue());
                }
                if (!scope.path("podUid").textValue().isEmpty()) {
                    scope.put("podUid", "aa36d481-0995-4060-8ce7-f3d42c3e408f")
                            .put("target", "/var/lib/kubelet/pods/aa36d481-0995-4060-8ce7-f3d42c3e408f/volumes/kubernetes.io~csi/lab-volume/mount");
                }
                if (record.has("runtime")) {
                    ((com.fasterxml.jackson.databind.node.ObjectNode) record.path("runtime")).put("podUid", scope.path("podUid").textValue());
                }
            }
            if (record.has("intentHash")) { record.put("intentHash", sha(plan)); }
            record.put("previous", previous);
            for (String field : List.of("begin", "publish", "stop")) {
                if (record.has(field)) {
                    ((com.fasterxml.jackson.databind.node.ObjectNode) record.path(field)).put("hash", hashes.get(record.path(field).path("sequence").longValue()));
                }
            }
            record.remove("hash");
            previous = sha(json.writeValueAsBytes(record));
            record.put("hash", previous);
            hashes.put(record.path("sequence").longValue(), previous);
            frames.add(record);
        }
        var prefixes = new java.util.ArrayList<com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Evidence>();
        var bytes = new java.io.ByteArrayOutputStream();
        var output = new java.io.DataOutputStream(bytes);
        for (var frame : frames) {
            byte[] encoded = json.writeValueAsBytes(frame);
            output.writeInt(encoded.length);
            output.write(encoded);
            if (List.of(2L, 3L, 6L, 8L, 10L).contains(frame.path("sequence").longValue())) {
                prefixes.add(com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.verify(bytes.toByteArray(),
                        new com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Cursor(frame.path("sequence").longValue(), frame.path("hash").textValue())));
            }
        }
        var armed = prefixes.get(0);
        var published = prefixes.get(2);
        var scope = armed.stream().observations().getFirst().scope();
        var node = new WorkspaceCsiNodeSourceStore.Node("owned-node", armed.stream().incarnation(), armed.stream().source(),
                URI.create("https://source.invalid"), "spiffe://test/source", URI.create("https://gateway.invalid"), "spiffe://test/gateway",
                frames.get(1).path("policy").path("rawSha256").textValue());
        var configuration = new WorkspaceCsiNodeSourceStore.Configuration(node, frames.get(1).path("imageDigest").textValue(), scope);
        var association = new WorkspaceCsiNodeSourceStore.Association(scope.bindingId(), 1, identity.path("physicalKey").textValue(),
                UUID.randomUUID().toString(), 1, configuration, "PUBLISHED", 3, armed, frames.get(2).path("scope").path("podUid").textValue(),
                frames.get(2).path("gatedSpecSha256").textValue(), prefixes.get(1), published);
        WorkspaceCsiNodeSourceStore.validate(association);
        return new PhysicalFixture(association, prefixes.get(3), prefixes.get(4));
    }

    @Test
    void globalPhysicalAuditReadsEmptySchemaAndBlocksUnknownOwnersWithoutExpandingParentRoots() throws Exception {
        var expected = historicalKeys();
        var references = Map.of("session", java.util.Set.of("older-session"), "binding", java.util.Set.of("older-binding"));
        for (String kind : List.of("empty", "original", "unknown", "bad-id", "schema")) {
            jdbc.update("DELETE FROM managed_workspace_csi_physical");
            if (!kind.equals("empty") && !kind.equals("schema")) {
                jdbc.update("INSERT INTO managed_workspace_csi_physical"
                        + " (retirement_id,binding_id,physical_key,record_version,record_bytes,record_sha256) VALUES (?,?,?,1,?,?)",
                        kind.equals("bad-id") ? "invalid" : UUID.randomUUID().toString(),
                        kind.equals("original") ? "older-binding" : "foreign-binding", "e".repeat(64), new byte[] {1}, "a".repeat(64));
            }
            if (kind.equals("schema")) {
                jdbc.execute("ALTER TABLE managed_workspace_csi_physical ADD unexpected VARCHAR(10)");
            }
            var queries = new java.util.ArrayList<String>();
            try (var target = source.getConnection()) {
                target.setAutoCommit(false);
                target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
                try {
                    var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime(),
                            (scan, carrier) -> { throw new AssertionError("An unknown owner cannot reach the consumer"); });
                    var current = WorkspaceCsiApplicationInventory.historicalScan(read, expected, references);
                    var result = WorkspaceCsiApplicationInventory.auditPhysicalCandidates(read, current);
                    assertThat(queries).anyMatch(sql -> sql.contains("FROM managed_workspace_csi_physical t WHERE 1 = 1"));
                    assertThat(result.bytes()).isNotEqualTo(new byte[0]);
                    if (kind.equals("empty")) {
                        assertThat(result.blockers()).isEmpty();
                        assertThat(result.bytes()).isEqualTo(current.bytes());
                        assertThat(result.rowCount()).isEqualTo(current.rowCount());
                        assertThat(result.byteCount()).isEqualTo(current.byteCount());
                    } else {
                        assertThat(result.blockers()).anyMatch(blocker -> blocker.table().equals("managed_workspace_csi_physical")
                                && blocker.code().equals(kind.equals("schema") ? "schema_drift"
                                        : kind.equals("original") ? "unsupported_original_physical_outcome" : "unsupported_historical_physical_owner"));
                        assertThat(result.rowCount()).isEqualTo(current.rowCount() + (kind.equals("schema") ? 0 : 1));
                    }
                    assertThat(references).isEqualTo(Map.of("session", java.util.Set.of("older-session"), "binding", java.util.Set.of("older-binding")));
                    assertThat(expected.bytes()).isEqualTo(historicalKeys().bytes());
                } finally {
                    target.rollback();
                }
            }
        }
    }

    @Test
    void preparedHistoryReplaysTheTypedPrefixAndRejectsScopeReferenceAndHashDrift() throws Exception {
        var json = new ObjectMapper();
        com.fasterxml.jackson.databind.JsonNode fixture;
        try (var input = getClass().getResourceAsStream("/csi-native-text-fixture.json")) {
            assertThat(input).isNotNull();
            fixture = json.readTree(input);
        }
        var key = fixture.path("expected").path("sessionKey");
        var original = CsiFilesRetirementProfile.request(new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                key.path("tenantId").textValue(), key.path("workspaceId").textValue(), 1, "unit-storage", ".",
                CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), fixture.path("expected").path("cwd").textValue(),
                key.path("sessionId").textValue());
        var baseline = preparedNativeFixture(WorkspaceCsiApplicationInventory.expectedImage(inspect().tables()), fixture);
        byte[] body = json.writeValueAsBytes(fixture.path("requests").get(32));
        var proof = WorkspaceCsiApplicationHistory.preparedTerminal(baseline, original, body);
        var owner = new JdbcCsiFilesRetirementGuard.Original(original, "binding", 1,
                RuntimeBindingRecord.State.DRAINING, true, 3, 2L);
        WorkspaceCsiApplicationHistory.verifyRetainedExecutions(baseline, owner, proof, List.of(), 2, Map.of());
        assertThatThrownBy(() -> WorkspaceCsiApplicationHistory.verifyRetainedExecutions(baseline, owner, proof,
                List.of(), 0, Map.of())).isInstanceOf(IllegalArgumentException.class);
        assertThat(proof.predecessorSequence()).isEqualTo(41);
        assertThat(proof.terminalSequence()).isEqualTo(42);
        assertThat(proof.lastRecordUuid()).isEqualTo("fc17e89d-c50c-4b55-b69d-aa58659e7242");
        for (var fault : List.of(
                List.of("qwen_managed_session_resource", "workspace_id", "other"),
                List.of("qwen_managed_session_resource", "session_scope_key", "b".repeat(64)),
                List.of("qwen_managed_session_resource", "sha256", "b".repeat(64)),
                List.of("qwen_managed_session_resource", "storage_kind", "OBJECT_STORAGE"),
                List.of("qwen_managed_session_resource_ref", "workspace_id", "other"),
                List.of("qwen_managed_session_resource_ref", "journal_revision", "32"),
                List.of("qwen_managed_session_journal_tx", "record_digest", "b".repeat(64)),
                List.of("qwen_managed_session_journal_head", "activation_head_revision", "2"),
                List.of("qwen_managed_session_journal_head", "activation_head_revision", "3"),
                List.of("qwen_managed_session_journal_head", "activation_head_revision", "33"),
                List.of("qwen_managed_session_journal_head", "activation_expires_at", "1"),
                List.of("qwen_managed_session_journal_head", "activation_id", "other"),
                List.of("qwen_managed_session_journal_head", "writer_id", UUID.randomUUID().toString()),
                List.of("qwen_managed_session_journal_head", "activation_phase", "released"))) {
            var changed = nativeCellFixture(baseline, fault.get(0), fault.get(1), fault.get(2));
            assertThatThrownBy(() -> WorkspaceCsiApplicationHistory.preparedTerminal(changed, original, body))
                    .isInstanceOfAny(IllegalArgumentException.class, com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        }
        var tables = new java.util.ArrayList<>(baseline.tables());
        var references = baseline.table("qwen_managed_session_resource_ref");
        tables.set(tables.indexOf(references), new WorkspaceCsiApplicationInventory.Table(references.name(),
                references.columns(), references.primaryKey(), references.rows().subList(1, references.rows().size())));
        var missing = WorkspaceCsiApplicationInventory.expectedImage(tables);
        assertThatThrownBy(() -> WorkspaceCsiApplicationHistory.preparedTerminal(missing, original, body))
                .isInstanceOfAny(IllegalArgumentException.class, com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        var candidate = fixture.path("requests").get(32).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) candidate.path("resources").get(0)).put("digest", "c".repeat(64));
        byte[] badCandidate = json.writeValueAsBytes(candidate);
        assertThatThrownBy(() -> WorkspaceCsiApplicationHistory.preparedTerminal(baseline, original, badCandidate))
                .isInstanceOfAny(IllegalArgumentException.class, com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        assertThat(WorkspaceCsiApplicationHistory.preparedTerminal(baseline, original, body)).isEqualTo(proof);
    }

    private static WorkspaceCsiApplicationInventory.Snapshot preparedNativeFixture(
            WorkspaceCsiApplicationInventory.Snapshot catalogue, com.fasterxml.jackson.databind.JsonNode fixture) {
        var key = fixture.path("expected").path("sessionKey");
        String nativeSession = key.path("sessionId").textValue();
        String nativeTenant = key.path("tenantId").textValue();
        String scope = ManagedSessionStore.sessionScopeKey(nativeTenant, nativeSession);
        Map<String, byte[]> bodies = new java.util.LinkedHashMap<>();
        for (var resource : fixture.path("originalResources")) {
            bodies.put(resource.path("ref").path("resourceId").textValue(),
                    java.util.Base64.getDecoder().decode(resource.path("bytesBase64").textValue()));
        }
        Map<String, List<WorkspaceCsiApplicationInventory.Row>> rows = new java.util.LinkedHashMap<>();
        rows.put("qwen_managed_session_journal_tx", new java.util.ArrayList<>());
        rows.put("qwen_managed_session_resource_ref", new java.util.ArrayList<>());
        Map<String, WorkspaceCsiApplicationInventory.Row> resources = new java.util.LinkedHashMap<>();
        for (int index = 0; index < 32; index++) {
            var request = fixture.path("requests").get(index);
            var values = nativeFixtureScope(catalogue, "qwen_managed_session_journal_tx", key);
            for (var column : catalogue.table("qwen_managed_session_journal_tx").columns()) {
                String camel = java.util.Arrays.stream(column.name().split("_"))
                        .reduce((first, next) -> first + Character.toUpperCase(next.charAt(0)) + next.substring(1)).orElseThrow();
                var value = request.path(camel);
                if (value.isValueNode() && !value.isNull()) {
                    values.put(column.name(), value.asText().getBytes(StandardCharsets.UTF_8));
                }
            }
            byte[] raw = java.util.Base64.getDecoder().decode(request.path("recordBytesBase64").textValue());
            values.put("record_bytes", raw);
            values.put("byte_length", Integer.toString(raw.length).getBytes(StandardCharsets.UTF_8));
            values.put("record_encoding", "identity".getBytes(StandardCharsets.UTF_8));
            values.put("journal_revision", Integer.toString(index + 1).getBytes(StandardCharsets.UTF_8));
            rows.get("qwen_managed_session_journal_tx").add(WorkspaceCsiApplicationInventory.expectedRow(
                    "qwen_managed_session_journal_tx", values, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
            for (var resource : request.path("resources")) {
                String id = resource.path("resourceId").textValue();
                var resourceValues = nativeFixtureScope(catalogue, "qwen_managed_session_resource", key);
                for (var field : Map.of("session_scope_key", scope, "resource_id", id,
                        "kind", resource.path("kind").textValue(), "schema_version", resource.path("schemaVersion").asText(),
                        "byte_length", resource.path("byteLength").asText(), "sha256", resource.path("digest").textValue(),
                        "storage_kind", "MYSQL_INLINE", "state", "REFERENCED").entrySet()) {
                    resourceValues.put(field.getKey(), field.getValue().getBytes(StandardCharsets.UTF_8));
                }
                resourceValues.put("inline_bytes", bodies.get(id));
                resources.putIfAbsent(id, WorkspaceCsiApplicationInventory.expectedRow("qwen_managed_session_resource",
                        resourceValues, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
                var refValues = nativeFixtureScope(catalogue, "qwen_managed_session_resource_ref", key);
                refValues.put("session_scope_key", scope.getBytes(StandardCharsets.UTF_8));
                refValues.put("resource_id", id.getBytes(StandardCharsets.UTF_8));
                refValues.put("journal_revision", Integer.toString(index + 1).getBytes(StandardCharsets.UTF_8));
                rows.get("qwen_managed_session_resource_ref").add(WorkspaceCsiApplicationInventory.expectedRow(
                        "qwen_managed_session_resource_ref", refValues, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
            }
        }
        rows.put("qwen_managed_session_resource", List.copyOf(resources.values()));
        var head = nativeFixtureScope(catalogue, "qwen_managed_session_journal_head", key);
        for (var field : Map.of("journal_revision", "32", "committed_sequence", "41", "state", "ACTIVE",
                "storage_version", "1", "recovery_status", "READY", "compacted_through_revision", "0",
                "writer_generation", "1", "activation_phase", "active", "activation_epoch", "1", "activation_event_epoch", "1").entrySet()) {
            head.put(field.getKey(), field.getValue().getBytes(StandardCharsets.UTF_8));
        }
        var activation = com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.records(java.util.Base64.getDecoder()
                .decode(fixture.path("requests").get(1).path("recordBytesBase64").textValue())).getFirst().path("managedSession").path("payload");
        head.put("activation_id", activation.path("activationId").textValue().getBytes(StandardCharsets.UTF_8));
        head.put("activation_expires_at", activation.path("expiresAt").asText().getBytes(StandardCharsets.UTF_8));
        head.put("activation_head_revision", "32".getBytes(StandardCharsets.UTF_8));
        head.put("writer_id", fixture.path("expected").path("writerId").textValue().getBytes(StandardCharsets.UTF_8));
        head.put("latest_checkpoint_resource_id", fixture.path("requests").get(31).path("latestCheckpointResourceId")
                .textValue().getBytes(StandardCharsets.UTF_8));
        head.put("last_commit_digest", fixture.path("requests").get(31).path("commitDigest").textValue().getBytes(StandardCharsets.UTF_8));
        rows.put("qwen_managed_session_journal_head", List.of(WorkspaceCsiApplicationInventory.expectedRow(
                "qwen_managed_session_journal_head", head, WorkspaceCsiApplicationInventory.Membership.ORIGINAL)));
        return WorkspaceCsiApplicationInventory.expectedImage(catalogue.tables().stream().map(table ->
                new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(),
                        rows.getOrDefault(table.name(), List.of()).stream()
                                .sorted(WorkspaceCsiApplicationInventory::compareKeys).toList())).toList());
    }

    private static WorkspaceCsiApplicationInventory.Snapshot nativeCellFixture(WorkspaceCsiApplicationInventory.Snapshot baseline,
            String name, String field, String value) {
        var table = baseline.table(name);
        var rows = new java.util.ArrayList<>(table.rows());
        var row = rows.getFirst();
        Map<String, byte[]> values = new java.util.LinkedHashMap<>();
        row.fields().forEach((column, cell) -> values.put(column, cell.bytes()));
        values.put(field, value.getBytes(StandardCharsets.UTF_8));
        rows.set(0, WorkspaceCsiApplicationInventory.expectedRow(name, values, row.membership()));
        rows.sort(WorkspaceCsiApplicationInventory::compareKeys);
        var tables = new java.util.ArrayList<>(baseline.tables());
        tables.set(tables.indexOf(table), new WorkspaceCsiApplicationInventory.Table(name, table.columns(), table.primaryKey(), rows));
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private static Map<String, byte[]> nativeFixtureScope(WorkspaceCsiApplicationInventory.Snapshot catalogue,
            String table, com.fasterxml.jackson.databind.JsonNode key) {
        Map<String, byte[]> values = new java.util.LinkedHashMap<>();
        catalogue.table(table).columns().forEach(column -> values.put(column.name(), null));
        values.put("tenant_id", key.path("tenantId").textValue().getBytes(StandardCharsets.UTF_8));
        values.put("workspace_id", key.path("workspaceId").textValue().getBytes(StandardCharsets.UTF_8));
        values.put("session_id", key.path("sessionId").textValue().getBytes(StandardCharsets.UTF_8));
        return values;
    }

    @Test
    void inventoriesEveryDeclaredTableAndPreservesRealPrivateCreationFacts() throws Exception {
        var snapshot = inspect();
        assertThat(snapshot.tables()).hasSize(62);
        assertThat(snapshot.tables().stream().map(table -> table.columns().size()).mapToInt(Integer::intValue).sum()).isEqualTo(847);
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

    @Test
    void fixedKeyReaderPreservesTypedBytesWithoutLockingOrReadingSharedHolderRows() throws Exception {
        var expected = historicalKeys();
        var queries = new java.util.ArrayList<String>();
        var result = readKeys(expected, queries);
        assertThat(result.blockers()).isEmpty();
        assertThat(result.bytes()).isEqualTo(expected.bytes());
        assertThat(queries).hasSize(62).allMatch(sql -> sql.startsWith("SELECT t.* FROM ") && !sql.contains("FOR UPDATE"));
        assertThat(queries).anyMatch(sql -> sql.startsWith("SELECT t.* FROM managed_workspace_execution_lease t WHERE 1 = 0"));
        assertThat(queries).noneMatch(sql -> sql.contains("storage_key = ?") || sql.contains("physical_key = ?"));
        assertThat(result.table("managed_workspace_create_command").rows().getFirst().binary("actor_id"))
                .isEqualTo(expected.table("managed_workspace_create_command").rows().getFirst().binary("actor_id"));
    }

    @Test
    void fixedKeyReaderRefusesChangedAndMissingOriginalRows() throws Exception {
        var expected = historicalKeys();
        jdbc.update("UPDATE managed_agent_session SET approval_mode = 'changed' WHERE tenant_id = 'tenant' AND session_id = ?", session);
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("managed_agent_session") && blocker.code().equals("historical_row_changed"));
        jdbc.update("DELETE FROM managed_agent_event WHERE tenant_id = 'tenant' AND session_id = ?", session);
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("managed_agent_event") && blocker.code().equals("missing_historical_key"));
    }

    @Test
    void fixedContextMasksIgnoreDisplayNameAndRefuseOriginalConfigurationChanges() throws Exception {
        var expected = historicalKeys();
        jdbc.update("UPDATE managed_workspace_registry SET display_name = 'renamed' WHERE tenant_id = 'tenant' AND workspace_id = 'workspace'");
        assertThat(readKeys(expected, new java.util.ArrayList<>()).bytes()).isEqualTo(expected.bytes());
        jdbc.update("UPDATE managed_workspace_registry SET policy_ref = 'changed' WHERE tenant_id = 'tenant' AND workspace_id = 'workspace'");
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("managed_workspace_registry") && blocker.code().equals("historical_row_changed"));
        assertThatThrownBy(() -> WorkspaceCsiPhysicalHistoryImage.context("managed_agent_event",
                expected.table("managed_agent_event").rows().getFirst())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fixedKeyReaderChecksEmptyTableSchemasAndRefusesMutableConnectionsBeforeSql() throws Exception {
        var expected = historicalKeys();
        jdbc.execute("ALTER TABLE managed_agent_action ADD COLUMN unexpected BIGINT");
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("managed_agent_action") && blocker.code().equals("schema_drift"));
        try (var target = source.getConnection()) {
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalKeys(target, expected))
                    .isInstanceOf(IllegalArgumentException.class);
            target.setAutoCommit(false);
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalKeys(target, expected))
                    .isInstanceOf(IllegalArgumentException.class);
            target.rollback();
        }
    }

    @Test
    void referencedReaderFindsExtraTypedOwnersWithoutAddingTheirRowsToTheOriginalImage() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                + " VALUES ('foreign', ?, 'late', 'COMPLETED', '{}', 1)", session);
        var result = readReferences(expected);
        assertThat(result.blockers()).anyMatch(blocker -> blocker.table().equals("managed_agent_action")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(result.table("managed_agent_action").rows()).isEmpty();
        assertThat(result.rowCount()).isGreaterThan(expected.rowCount());
    }

    @Test
    void referencedReaderStrictlyDecodesForeignJsonAndEscapedReferenceNames() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                + " VALUES ('foreign', 'new-session', 'candidate', 'COMPLETED', '{}', 1)");
        String escaped = "{\"nested\":[{\"session\\u0049d\":\"" + session.replace("-", "\\u002d") + "\"}]}";
        for (String json : List.of(escaped, "{", "{\"sessionId\":\"" + session + "\",\"sessionId\":\"new-session\"}", "{} {}")) {
            jdbc.update("UPDATE managed_agent_action SET options_json = ? WHERE action_id = 'candidate'", json);
            assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("managed_agent_action")
                    && (blocker.code().equals("extra_historical_reference") || blocker.code().equals("invalid_historical_payload")));
        }
        jdbc.update("UPDATE managed_agent_action SET options_json = ? WHERE action_id = 'candidate'",
                "{\"text\":\"" + session + "\",\"payloadJson\":\"{\\\"sessionId\\\":\\\"" + session + "\\\"}\"}");
        assertThat(readReferences(expected).blockers()).isEmpty();
    }

    @Test
    void referencedReaderChecksInlineMetadataAndKeepsResourceIdsLocalToTheirOwner() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        byte[] harmless = "{\"cwd\":\"/workspace\"}".getBytes(StandardCharsets.UTF_8);
        foreignResource("same-local-id", "managed-root", harmless);
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE qwen_managed_session_resource SET sha256 = ? WHERE resource_id = 'same-local-id'", "0".repeat(64));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE qwen_managed_session_resource SET sha256 = ?, kind = 'unknown-format' WHERE resource_id = 'same-local-id'", sha(harmless));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("unsupported_historical_payload"));
    }

    @Test
    void referencedReaderReassemblesSplitUtf8BeforeCheckingMessageReferences() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        byte[] body = new ObjectMapper().createObjectNode().put("padding", "a" + "\uD83D\uDE00".repeat(18000))
                .put("sessionId", session).toString().getBytes(StandardCharsets.UTF_8);
        byte[] first = java.util.Arrays.copyOfRange(body, 0, 60 * 1024);
        byte[] last = java.util.Arrays.copyOfRange(body, first.length, body.length);
        assertThatThrownBy(() -> StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(first))).isInstanceOf(java.nio.charset.CharacterCodingException.class);
        foreignResource("a-part", "managed-message-part", first);
        foreignResource("b-part", "managed-message-part", last);
        var manifest = new ObjectMapper().createObjectNode();
        var parts = manifest.putArray("parts");
        for (var entry : Map.of("a-part", first, "b-part", last).entrySet().stream().sorted(Map.Entry.comparingByKey()).toList()) {
            parts.addObject().put("resourceId", entry.getKey()).put("kind", "managed-message-part").put("schemaVersion", 1)
                    .put("byteLength", entry.getValue().length).put("digest", sha(entry.getValue()));
        }
        foreignResource("z-manifest", "managed-message-chunks", manifest.toString().getBytes(StandardCharsets.UTF_8));
        var found = readReferences(expected);
        assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_resource")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(found.blockers()).noneMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        byte[] unrelated = new ObjectMapper().createObjectNode().put("padding", "a" + "\uD83D\uDE00".repeat(18000))
                .put("sessionId", "foreign-session").toString().getBytes(StandardCharsets.UTF_8);
        jdbc.update("DELETE FROM qwen_managed_session_resource");
        byte[] end = java.util.Arrays.copyOfRange(unrelated, first.length, unrelated.length);
        foreignResource("a-part", "managed-message-part", first);
        foreignResource("b-part", "managed-message-part", end);
        ((com.fasterxml.jackson.databind.node.ObjectNode) parts.get(1)).put("byteLength", end.length).put("digest", sha(end));
        foreignResource("z-manifest", "managed-message-chunks", manifest.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("DELETE FROM qwen_managed_session_resource WHERE resource_id = 'z-manifest'");
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    private void foreignResource(String id, String kind, byte[] bytes) {
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id, resource_id,"
                + " kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, created_at)"
                + " VALUES (?, 'foreign', 'other-workspace', 'foreign-session', ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', CURRENT_TIMESTAMP(6))",
                ManagedSessionStore.sessionScopeKey("foreign", "foreign-session"), id, kind, bytes.length, sha(bytes), bytes);
    }

    @Test
    void referencedReaderSharesNativeInputArrayContract() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        byte[] originalInput;
        try (var input = getClass().getResourceAsStream("/csi-native-text-fixture.json")) {
            assertThat(input).isNotNull();
            var fixture = new ObjectMapper().readTree(input);
            var resources = fixture.path("originalResources");
            var resource = java.util.stream.StreamSupport.stream(resources.spliterator(), false)
                    .filter(value -> value.path("ref").path("kind").asText().equals("managed-input")).findFirst().orElseThrow();
            originalInput = java.util.Base64.getDecoder().decode(resource.path("bytesBase64").textValue());
        }
        foreignResource("foreign-input", "managed-input", originalInput);
        assertThat(readReferences(expected).blockers()).isEmpty();
        byte[] literal = ("[{\"type\":\"text\",\"text\":\"" + session + "\"}]").getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE resource_id='foreign-input'",
                literal, literal.length, sha(literal));
        assertThat(readReferences(expected).blockers()).isEmpty();
        for (byte[] malformed : List.of("{}".getBytes(StandardCharsets.UTF_8), "[]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"image\",\"text\":\"x\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":null}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\",\"extra\":true}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\",\"text\":\"y\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\"}] []".getBytes(StandardCharsets.UTF_8), new byte[] {(byte) 0xff}, new byte[65537])) {
            jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE resource_id='foreign-input'",
                    malformed, malformed.length, sha(malformed));
            assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_resource")
                    && blocker.code().equals("invalid_historical_payload"));
        }
    }

    @Test
    void referencedReaderChecksJournalBytesAndReferencesWithTheirActualOwner() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        byte[] records = ("{\"sessionId\":\"foreign-session\",\"payload\":{\"bindingId\":\"" + binding.getBindingId() + "\"}}\n")
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO qwen_managed_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence,"
                + " event_count, writer_generation, writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes, byte_length, record_digest, created_at)"
                + " VALUES ('foreign', 'other-workspace', 'foreign-session', 1, ?, 'tx', 'operation', 'command', ?, 1, 1, 1, 1, 'writer', ?,"
                + " 1, 'identity', ?, ?, ?, CURRENT_TIMESTAMP(6))", "a".repeat(64), "b".repeat(64), "c".repeat(64), records, records.length, sha(records));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("qwen_managed_session_journal_tx")
                && blocker.code().equals("extra_historical_reference"));
        byte[] harmless = "{\"sessionId\":\"foreign-session\",\"payload\":{\"text\":\"ordinary\"}}\n".getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?",
                harmless, harmless.length, sha(harmless));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_digest = ?", "0".repeat(64));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    @Test
    void referencedReaderCountsAllCandidateRowsAndRefusesOverLimitBeforeExpandingTheImage() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        try (var connection = source.getConnection(); var statement = connection.prepareStatement(
                "INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                        + " VALUES ('foreign', 'new-session', ?, 'COMPLETED', '{}', 1)")) {
            for (int index = 0; index <= WorkspaceCsiApplicationInventory.MAX_ROWS; index++) {
                statement.setString(1, String.format("%05d", index));
                statement.addBatch();
            }
            statement.executeBatch();
        }
        var result = readReferences(expected);
        assertThat(result.blockers()).anyMatch(blocker -> blocker.code().equals("row_limit"));
        assertThat(result.rowCount()).isEqualTo(WorkspaceCsiApplicationInventory.MAX_ROWS);
        assertThat(result.table("managed_agent_action").rows()).isEmpty();
    }

    @Test
    void referencedReaderTreatsDeclaredRawOutputAsDataAndRejectsExternalStructuredPayloads() throws Exception {
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        var json = new ObjectMapper();
        var contract = json.readTree(java.nio.file.Path.of("../../core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json").toFile())
                .path("cases").get(0).path("value");
        byte[] bindingBytes = json.writeValueAsBytes(contract);
        ToolPublicationContract.parseBytes("binding", bindingBytes);
        String scope = ToolPublicationDataStore.scope("tenant-1", "workspace-1", "session-1");
        jdbc.update("INSERT INTO qwen_tool_publication (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id,"
                + " execution_key, capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes)"
                + " VALUES (?, ?, 'tenant-1', 'workspace-1', 'session-1', 'publication-1', ?, 'capture-1', ?, ?, ?, 'OPEN', 1024, 1024, 1024)",
                scope, "a".repeat(64), sha(contract.path("executionCallId").textValue().getBytes(StandardCharsets.UTF_8)), new String(bindingBytes, StandardCharsets.UTF_8),
                ToolPublicationContract.bindingDigest(contract), "c".repeat(64));
        byte[] raw = ("{\"bindingId\":\"" + binding.getBindingId() + "\"}").getBytes(StandardCharsets.UTF_8);
        String contentId = "result-" + sha((scope + ":publication-1:content:output").getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key, resource_id, resource_kind,"
                + " byte_length, sha256, inline_bytes, state, operation_id, created_at)"
                + " VALUES (?, 'publication-1', 'content:output', ?, 'managed-tool-result-content', ?, ?, ?, 'VERIFIED', 'publish', CURRENT_TIMESTAMP(6))",
                scope, contentId, raw.length, sha(raw), raw);
        assertThat(readReferences(expected).blockers()).isEmpty();
        assertThat(ToolPublicationContract.bindingDigest(contract)).isNotEqualTo(sha(bindingBytes));
        jdbc.update("UPDATE qwen_tool_publication SET binding_digest = ?", sha(bindingBytes));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE qwen_tool_publication SET binding_digest = ?", ToolPublicationContract.bindingDigest(contract));
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = NULL, object_key = ?",
                "managed-tool-results/" + scope + "/publication-1/" + sha("content:output".getBytes(StandardCharsets.UTF_8)));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE qwen_tool_publication_object SET slot_key = 'terminal', resource_kind = 'managed-tool-terminal', resource_id = ?, object_key = ?",
                "result-" + sha((scope + ":publication-1:terminal").getBytes(StandardCharsets.UTF_8)).substring(0, 32),
                "managed-tool-results/" + scope + "/publication-1/" + sha("terminal".getBytes(StandardCharsets.UTF_8)));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("unsupported_historical_payload"));
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?, object_key = NULL", raw);
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    @Test
    void referencedReaderFindsReadLeaseAliasesUsingVerifiedOriginalReadIds() throws Exception {
        String readId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO qwen_csi_resource_read (read_id, tenant_id, workspace_id, session_id, request_key, binding_id,"
                + " runtime_generation, binding_version, writer_id, writer_generation, writer_token_hash, journal_revision, activation_epoch,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, resource_state, state, started_at, delivery_expires_at, ended_at)"
                + " VALUES (?, 'tenant', 'workspace', ?, ?, ?, 1, 1, 'writer', 1, ?, 1, 1, 'resource', 'managed-root', 1, 2, ?,"
                + " 'MYSQL_INLINE', 'REFERENCED', 'RETURNED', 1, 2, 2)", readId, session, binding.getRequest().requestKey(),
                binding.getBindingId(), "a".repeat(64), sha("{}".getBytes(StandardCharsets.UTF_8)));
        var expected = historicalKeys();
        jdbc.update("DELETE FROM managed_workspace_execution_lease");
        String unrelated = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO qwen_output_read_lease (lease_id, tenant_key, session_key, retirement_generation, expires_at)"
                + " VALUES (?, ?, ?, 0, 2)", unrelated, "b".repeat(64), "c".repeat(64));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE qwen_output_read_lease SET lease_id = ? WHERE lease_id = ?", readId, unrelated);
        var found = readReferences(expected);
        assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("qwen_output_read_lease")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(found.table("qwen_output_read_lease").rows()).isEmpty();
    }

    private WorkspaceCsiApplicationInventory.Snapshot readReferences(WorkspaceCsiApplicationInventory.Snapshot expected) throws Exception {
        return readHistory(expected, new java.util.ArrayList<>(), true);
    }

    @Test
    void savedBaselineCannotHideOriginalEventsUsingCanonicalMembershipLabels() throws Exception {
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            try {
                var actual = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                assertThat(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, baseline))
                        .noneMatch(blocker -> blocker.code().equals("invalid_historical_membership")
                                || blocker.code().equals("original_row_hidden_as_other"));
                for (var label : new WorkspaceCsiApplicationInventory.Membership[]{WorkspaceCsiApplicationInventory.Membership.CONTEXT,
                        WorkspaceCsiApplicationInventory.Membership.OTHER}) {
                    var changed = relabel(baseline, "managed_agent_event", label);
                    assertThat(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, changed))
                            .anyMatch(blocker -> blocker.table().equals("managed_agent_event") && blocker.code().equals(
                                    label == WorkspaceCsiApplicationInventory.Membership.CONTEXT
                                            ? "invalid_historical_membership" : "original_row_hidden_as_other"));
                }
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void baselineBindingVersionCanExceedTheImmutableAuthorizationCeiling() throws Exception {
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var repository = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var claimed = repository.claimOperation(binding.getBindingId(), "resumed-coordinator", Duration.ofMinutes(1));
        assertThat(claimed.getVersion()).isGreaterThan(intent.sealedBindingVersion());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            try {
                var actual = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                assertThat(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, baseline))
                        .noneMatch(blocker -> blocker.table().equals("qwen_runtime_binding"));
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void savedBaselineDecodesEscapedSessionReferencesWithoutGlobalizingLocalResourceIds() throws Exception {
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var definition = baseline.table("managed_agent_definition");
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            try {
                var actual = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                String escaped = session.chars().mapToObj(value -> String.format("\\u%04x", value))
                        .collect(java.util.stream.Collectors.joining());
                String escapedReference = "{\"sessionId\":\"" + escaped + "\"}";
                for (String json : List.of(escapedReference, "{\"resourceId\":\"" + session + "\",\"text\":\"" + session + "\",\"payloadJson\":\"ordinary\"}")) {
                    var values = new java.util.LinkedHashMap<String, byte[]>();
                    definition.columns().forEach(column -> values.put(column.name(), null));
                    for (var entry : Map.of("tenant_id", "foreign", "agent_id", "qwen-code", "revision", "7",
                            "digest", "digest", "definition_json", json, "created_at", "1").entrySet()) {
                        values.put(entry.getKey(), entry.getValue().getBytes(StandardCharsets.UTF_8));
                    }
                    var other = WorkspaceCsiApplicationInventory.expectedRow(definition.name(), values, WorkspaceCsiApplicationInventory.Membership.OTHER);
                    var tables = new java.util.ArrayList<>(baseline.tables());
                    tables.set(tables.indexOf(definition), new WorkspaceCsiApplicationInventory.Table(definition.name(),
                            definition.columns(), definition.primaryKey(), List.of(other)));
                    var candidate = WorkspaceCsiApplicationInventory.expectedImage(tables);
                    var blockers = WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, candidate);
                    assertThat(blockers.stream().anyMatch(blocker -> blocker.code().equals("original_row_hidden_as_other")))
                            .isEqualTo(json.equals(escapedReference));
                }
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void savedIdentityDecoderRejectsUnknownMissingNullAndCoercedFields() throws Exception {
        byte[] canonical = WorkspaceCsiApplicationJson.encode(intent);
        assertThat(WorkspaceCsiApplicationJson.typedObject(canonical, 256 * 1024, WorkspaceCsiReservationStore.Retirement.class))
                .isEqualTo(intent);
        var json = new ObjectMapper();
        for (String mutation : List.of("unknown", "missing", "null", "string", "float")) {
            var value = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(canonical);
            switch (mutation) {
                case "unknown" -> value.put("unreviewed", true);
                case "missing" -> value.remove("sealedBindingVersion");
                case "null" -> value.putNull("sealedBindingVersion");
                case "string" -> value.put("sealedBindingVersion", Long.toString(intent.sealedBindingVersion()));
                case "float" -> value.put("sealedBindingVersion", intent.sealedBindingVersion() + 0.5);
                default -> throw new AssertionError(mutation);
            }
            assertThatThrownBy(() -> WorkspaceCsiApplicationJson.typedObject(WorkspaceCsiApplicationJson.encode(value),
                    256 * 1024, WorkspaceCsiReservationStore.Retirement.class)).as(mutation).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void savedNativeInputWrapperDecodesItsDeclaredPayloadCarrier() throws Exception {
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var resource = baseline.table("qwen_managed_session_resource");
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            try {
                var actual = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                for (String referenced : List.of(session, "foreign-session")) {
                    var json = new ObjectMapper();
                    String payload = json.writeValueAsString(Map.of("sessionId", referenced));
                    byte[] bytes = json.writeValueAsBytes(Map.of("harnessSessionId", "foreign-session",
                            "runtimeSessionId", "foreign-session", "payloadJson", payload));
                    var values = new java.util.LinkedHashMap<String, byte[]>();
                    resource.columns().forEach(column -> values.put(column.name(), null));
                    for (var entry : Map.of("session_scope_key", ManagedSessionStore.sessionScopeKey("foreign", "foreign-session"),
                            "tenant_id", "foreign", "workspace_id", "foreign-workspace", "session_id", "foreign-session",
                            "resource_id", "local", "kind", "managed-tool-input", "schema_version", "1", "byte_length", Integer.toString(bytes.length),
                            "sha256", sha(bytes)).entrySet()) {
                        values.put(entry.getKey(), entry.getValue().getBytes(StandardCharsets.UTF_8));
                    }
                    values.put("inline_bytes", bytes);
                    var row = WorkspaceCsiApplicationInventory.expectedRow(resource.name(), values, WorkspaceCsiApplicationInventory.Membership.OTHER);
                    var tables = new java.util.ArrayList<>(baseline.tables());
                    tables.set(tables.indexOf(resource), new WorkspaceCsiApplicationInventory.Table(resource.name(), resource.columns(),
                            resource.primaryKey(), List.of(row)));
                    var blockers = WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent,
                            WorkspaceCsiApplicationInventory.expectedImage(tables));
                    assertThat(blockers.stream().anyMatch(blocker -> blocker.code().equals("original_row_hidden_as_other")))
                            .isEqualTo(referenced.equals(session));
                }
            } finally {
                target.rollback();
            }
        }
    }

    private static WorkspaceCsiApplicationInventory.Snapshot relabel(WorkspaceCsiApplicationInventory.Snapshot baseline,
            String name, WorkspaceCsiApplicationInventory.Membership membership) {
        var table = baseline.table(name);
        var row = table.rows().getFirst();
        var values = new java.util.LinkedHashMap<String, byte[]>();
        row.fields().forEach((field, cell) -> values.put(field, cell.bytes()));
        var tables = new java.util.ArrayList<>(baseline.tables());
        tables.set(tables.indexOf(table), new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(),
                List.of(WorkspaceCsiApplicationInventory.expectedRow(name, values, membership))));
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private WorkspaceCsiApplicationInventory.Snapshot historicalKeys() throws Exception {
        var sourceImage = inspect();
        var context = java.util.Set.of("qwen_runtime_placement_guard", "qwen_tool_publication_tenant", "managed_workspace_registry");
        var tables = sourceImage.tables().stream().map(table -> new WorkspaceCsiApplicationInventory.Table(
                table.name(), table.columns(), table.primaryKey(), table.rows().stream()
                        .filter(row -> !table.name().equals("managed_workspace_execution_lease")
                                && (row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL
                                        || context.contains(table.name()) && row.membership() == WorkspaceCsiApplicationInventory.Membership.CONTEXT))
                        .map(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.CONTEXT
                                ? WorkspaceCsiPhysicalHistoryImage.context(table.name(), row) : row).toList())).toList();
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private WorkspaceCsiApplicationInventory.Snapshot readKeys(WorkspaceCsiApplicationInventory.Snapshot expected,
            List<String> queries) throws Exception {
        return readHistory(expected, queries, false);
    }

    private WorkspaceCsiApplicationInventory.Snapshot readHistory(WorkspaceCsiApplicationInventory.Snapshot expected,
            List<String> queries, boolean references) throws Exception {
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            var observed = observedRead(target, queries);
            try {
                if (references) {
                    var original = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), binding.getGeneration(),
                            binding.getState(), binding.isDrainRequested(), binding.getVersion(),
                            WorkspaceCsiApplicationImage.sole(expected, "qwen_runtime_binding").number("first_activation_journal_revision"));
                    return WorkspaceCsiApplicationInventory.readHistoricalReferencedKeys(observed, expected, original, intent, System.nanoTime());
                }
                return WorkspaceCsiApplicationInventory.readHistoricalKeys(observed, expected);
            } finally {
                target.rollback();
            }
        }
    }

    private static Connection observedRead(Connection target, List<String> queries) {
        // H2 does not retain JDBC readOnly; this unit guard records every actual query.
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("isReadOnly")) {
                        return true;
                    }
                    if (method.getName().equals("prepareStatement")) {
                        String sql = (String) arguments[0];
                        assertThat(sql).startsWith("SELECT ").doesNotContain("FOR UPDATE");
                        queries.add(sql);
                    }
                    try {
                        return method.invoke(target, arguments);
                    } catch (InvocationTargetException exception) {
                        throw exception.getCause();
                    }
                });
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
