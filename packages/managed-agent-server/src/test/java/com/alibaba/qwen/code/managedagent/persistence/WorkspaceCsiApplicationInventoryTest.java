package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCsiApplicationInventoryTest {
    @TempDir
    Path temp;
    private javax.sql.DataSource source;
    JdbcTemplate jdbc;
    private RuntimeBindingRecord binding;
    private WorkspaceCsiReservationStore.Retirement intent;
    private String session;

    @BeforeEach
    void setUp() {
        initialize(new DriverManagerDataSource("jdbc:h2:mem:application-inventory-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", ""));
    }

    void initialize(javax.sql.DataSource database) {
        source = database;
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var json = new ObjectMapper();
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        reservations.register(registration);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
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
    void liveInventoryFindsForeignCanonicalResourceReferencesWithoutTheirParentSession() throws Exception {
        String resource = ManagedSessionStore.resourceKey(sessionScope(), "original-resource");
        byte[] bytes = "{}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,"
                        + "kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                        + " VALUES (?,?,'tenant','workspace',?,'original-resource','managed-root',1,?,?,"
                        + "'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ")",
                resource, sessionScope(), session, bytes.length, sha(bytes), bytes);
        new TransactionTemplate(new DataSourceTransactionManager(source)).executeWithoutResult(status ->
                ToolPublicationRetentionStore.lockSession(jdbc, "foreign", "foreign-session"));
        jdbc.update("INSERT INTO ma_message (tenant_id,session_id,item_id,turn_id,item_type,item_status,attributes_json,"
                        + "first_sequence,last_sequence,gmt_create,gmt_modified,parts_json,body_resource_key)"
                        + " VALUES ('foreign','foreign-session','item','turn','message','completed','{}',1,1,1,1,'[]',?)", resource);
        jdbc.update("INSERT INTO ma_snapshot (tenant_id,session_id,snapshot_id,snapshot_version,covered_sequence,"
                        + "projection_version,manifest_resource_key,manifest_sha256,item_count,state,gmt_create,retain_until)"
                        + " VALUES ('foreign','foreign-session','snapshot',1,1,1,?,?,0,'PUBLISHED',1,2)", resource, sha(bytes));
        jdbc.update("INSERT INTO ma_event_stream (tenant_id,session_id,stream_kind,stream_id,artifact_refs_resource_key,gmt_modified)"
                        + " VALUES ('foreign','foreign-session','SESSION','',?,1)", resource);
        String foreignScope = ManagedSessionStore.sessionScopeKey("foreign", "foreign-session");
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key,owner_kind,owner_key,owner_revision,resource_key,"
                        + "tenant_id,session_id,resource_id,gmt_create) VALUES (?,'MESSAGE',?,1,?,'foreign',"
                        + "'foreign-session','original-resource'," + ManagedSchemaTime.SQL_NOW + ")", foreignScope, "a".repeat(64), resource);
        var found = inspect();
        for (String table : List.of("ma_message", "ma_snapshot", "ma_event_stream", "ma_resource_ref")) {
            assertThat(found.blockers()).as(table).anyMatch(blocker -> blocker.table().equals(table)
                    && blocker.code().equals("foreign_original_reference"));
            assertThat(found.table(table).rows()).anyMatch(row -> "foreign".equals(row.text("tenant_id")));
        }
    }

    @Test
    void liveInventoryPreservesOtherActualCreateReceiptsAndRejectsTheirHashDrift() throws Exception {
        var initial = inspect();
        assertThat(initial.blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
        assertThat(initial.table("ma_request_receipt").rows()).filteredOn(row -> "SESSION_CREATE_MODE".equals(row.text("namespace")))
                .allMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.CONTEXT);
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        transactions.executeWithoutResult(status -> ManagedReceipts.insert(jdbc,
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_MODE,
                "foreign", com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.TENANT,
                "foreign", "reserved-only", com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("false"),
                null, null, null, null, "RESERVED", null, false, 1));
        var found = inspect();
        assertThat(found.blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
        assertThat(found.table("ma_request_receipt").rows()).filteredOn(row -> "foreign".equals(row.text("tenant_id")))
                .hasSize(1).allMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER);
        var before = found.table("ma_request_receipt").rows().stream().filter(row -> "foreign".equals(row.text("tenant_id")))
                .findFirst().orElseThrow();
        assertThat(inspect().table("ma_request_receipt").rows()).anyMatch(row -> java.util.Arrays.equals(row.bytes(), before.bytes()));
        jdbc.update("UPDATE ma_request_receipt SET request_digest = ? WHERE receipt_key = ?", "broken", before.text("receipt_key"));
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("ma_request_receipt")
                && blocker.code().equals("unresolved_candidate_owner"));
    }

    @Test
    void liveInventoryPreservesCompletedWorkspaceCreationReceiptsFromTheActualProducer() throws Exception {
        var original = inspect();
        for (String owner : List.of("tenant", "foreign")) {
            var created = createOtherWorkspace(owner);
            String receiptKey = created.workspaceId().substring("workspace-".length());
            var before = jdbc.queryForMap("SELECT * FROM ma_request_receipt WHERE receipt_key = ?", receiptKey);
            var found = inspect();
            assertThat(found.blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
            var receipt = found.table("ma_request_receipt").rows().stream()
                    .filter(row -> receiptKey.equals(row.text("receipt_key"))).findFirst().orElseThrow();
            assertThat(receipt.membership()).isEqualTo(WorkspaceCsiApplicationInventory.Membership.OTHER);
            assertThat(found.table("ma_workspace").rows()).anyMatch(row -> owner.equals(row.text("tenant_id"))
                    && created.workspaceId().equals(row.text("workspace_id"))
                    && row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER);
            assertThat(found.table("ma_storage").rows()).anyMatch(row -> owner.equals(row.text("tenant_id"))
                    && ("created-" + receiptKey).equals(row.text("storage_id"))
                    && row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER);
            assertThat(inspect().table("ma_request_receipt").rows()).anyMatch(row -> java.util.Arrays.equals(row.bytes(), receipt.bytes()));
            assertThat(jdbc.queryForMap("SELECT * FROM ma_request_receipt WHERE receipt_key = ?", receiptKey))
                    .usingRecursiveComparison().isEqualTo(before);
            for (String table : List.of("ma_session", "ma_operation", "ma_storage_owner", "ma_runtime_binding", "ma_runtime_slot")) {
                assertThat(found.table(table).rows().stream().filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL)
                        .map(WorkspaceCsiApplicationInventory.Row::bytes).toList())
                        .usingRecursiveComparison().isEqualTo(original.table(table).rows().stream()
                                .filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL)
                                .map(WorkspaceCsiApplicationInventory.Row::bytes).toList());
            }
        }
    }

    @Test
    void workspaceCreationReceiptsRefuseChangedIdentityAndUnrelatedDomainFields() throws Exception {
        String receipt = createOtherWorkspace("foreign").workspaceId().substring("workspace-".length());
        var original = jdbc.queryForMap("SELECT * FROM ma_request_receipt WHERE receipt_key = ?", receipt);
        var changes = new java.util.LinkedHashMap<String, Object>();
        for (String field : List.of("tenant_key", "scope_key", "idempotency_digest", "request_digest", "result_operation_key")) {
            changes.put(field, "0".repeat(64));
        }
        changes.put("scope_id", "wrong-actor");
        changes.put("actor_id", new byte[] {1});
        changes.put("operation", "UNRECOGNIZED");
        changes.put("state", "PENDING");
        changes.put("idempotency_key", "invalid key");
        changes.put("workspace_bound", true);
        for (String field : List.of("session_id", "turn_id", "agent_id", "schedule_id", "channel_id", "action_id", "session_status_before")) {
            changes.put(field, "unrelated");
        }
        for (String field : List.of("agent_revision", "account_generation", "semantic_revision", "action_version", "mutation_attempt_sequence")) {
            changes.put(field, 1L);
        }
        for (var change : changes.entrySet()) {
            jdbc.update("UPDATE ma_request_receipt SET " + change.getKey() + " = ? WHERE receipt_key = ?", change.getValue(), receipt);
            assertWorkspaceReceiptBlocked(receipt);
            jdbc.update("UPDATE ma_request_receipt SET " + change.getKey() + " = ? WHERE receipt_key = ?", original.get(change.getKey()), receipt);
        }
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
    }

    @Test
    void workspaceCreationReceiptsRefuseChangedResultAndOriginalReferences() throws Exception {
        String receipt = createOtherWorkspace("foreign").workspaceId().substring("workspace-".length());
        String original = jdbc.queryForObject("SELECT result_json FROM ma_request_receipt WHERE receipt_key = ?", String.class, receipt);
        var json = new ObjectMapper();
        var details = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(original);
        var changed = List.of(
                details.deepCopy().put("workspaceId", "workspace"),
                details.deepCopy().put("storageId", "storage"),
                details.deepCopy().put("displayName", " Other Workspace "),
                details.deepCopy().put("displayName", "different"),
                details.deepCopy().put("registrationId", "1-1-1-1-1"),
                details.deepCopy().put("registrationId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
                details.deepCopy().put("registrationId", 1),
                details.deepCopy().put("sourceWorkspaceId", "other-workspace"),
                details.deepCopy().put("sourceWorkspaceId", "workspace"),
                details.deepCopy().put("sourceGeneration", 1),
                details.deepCopy().put("sourceGeneration", "1"),
                details.deepCopy().put("cwdRelative", "."),
                details.deepCopy().without("sourceWorkspaceId"),
                details.deepCopy().without("sourceGeneration"),
                details.deepCopy().without("cwdRelative"),
                details.deepCopy().putNull("workspaceId"),
                details.deepCopy().without("displayName"),
                details.deepCopy().put("unknown", "ordinary"),
                details.deepCopy().put("sessionId", session),
                details.deepCopy().put("bindingId", binding.getBindingId()));
        for (var value : changed) {
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", value.toString(), receipt);
            assertWorkspaceReceiptBlocked(receipt);
        }
        for (String malformed : List.of(original + "{}", original.substring(0, original.length() - 1) + ",\"displayName\":\"duplicate\"}")) {
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", malformed, receipt);
            assertThatThrownBy(this::inspect).isInstanceOf(IllegalArgumentException.class);
        }
        jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", original, receipt);
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
    }

    @Test
    void originalFourFieldWorkspaceReceiptRemainsExactAlongsideTheNewNullExtension() throws Exception {
        String receipt = createOtherWorkspace("foreign").workspaceId().substring("workspace-".length());
        String current = jdbc.queryForObject("SELECT result_json FROM ma_request_receipt WHERE receipt_key = ?", String.class, receipt);
        var legacy = (com.fasterxml.jackson.databind.node.ObjectNode) new ObjectMapper().readTree(current);
        for (String field : List.of("sourceWorkspaceId", "sourceGeneration", "cwdRelative")) {
            assertThat(legacy.path(field).isNull()).isTrue();
            legacy.remove(field);
        }
        assertThat(legacy.size()).isEqualTo(4);
        for (String raw : List.of(legacy.toString(), current)) {
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", raw, receipt);
            var found = inspect();
            assertThat(found.blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
            assertThat(found.table("ma_request_receipt").rows()).filteredOn(row -> receipt.equals(row.text("receipt_key")))
                    .hasSize(1).allMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER
                            && raw.equals(row.text("result_json")));
            assertThat(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt WHERE receipt_key = ?", String.class, receipt))
                    .isEqualTo(raw);
        }
    }

    @Test
    void workspaceCreationReceiptsRequireTheirActualParentsAndSeparatePhysicalStorage() throws Exception {
        for (String owner : List.of("tenant", "foreign")) {
            var created = createOtherWorkspace(owner);
            String receipt = created.workspaceId().substring("workspace-".length());
            String alias = JdbcRuntimeBindingRepository.storageAliasKey(owner, "created-" + receipt);
            for (String field : List.of("parent_session_id", "child_run_id", "child_workspace_id")) {
                jdbc.update("UPDATE ma_workspace SET " + field + " = ? WHERE tenant_id = ? AND workspace_id = ?", session, owner, created.workspaceId());
                assertWorkspaceReceiptBlocked(receipt);
                jdbc.update("UPDATE ma_workspace SET " + field + " = NULL WHERE tenant_id = ? AND workspace_id = ?", owner, created.workspaceId());
            }
            var before = jdbc.queryForMap("SELECT * FROM ma_storage WHERE alias_key = ?", alias);
            for (var change : Map.of("physical_key", intent.physicalKey(), "tenant_key", "0".repeat(64),
                    "storage_key", "1".repeat(64), "storage_kind", "UNREGISTERED", "registration_state", "RETIRING",
                    "fence_operation_id", "pending", "registration_json", "{\"schemaVersion\":1,\"operationId\":\"wrong\"}").entrySet()) {
                jdbc.update("UPDATE ma_storage SET " + change.getKey() + " = ? WHERE alias_key = ?", change.getValue(), alias);
                assertWorkspaceReceiptBlocked(receipt);
                jdbc.update("UPDATE ma_storage SET " + change.getKey() + " = ? WHERE alias_key = ?", before.get(change.getKey()), alias);
            }
            String deleted = "deleted-" + receipt;
            jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?", owner, created.workspaceId());
            jdbc.update("UPDATE ma_workspace SET workspace_id = ? WHERE tenant_id = ? AND workspace_id = ?", deleted, owner, created.workspaceId());
            assertWorkspaceReceiptBlocked(receipt);
            jdbc.update("UPDATE ma_workspace SET workspace_id = ? WHERE tenant_id = ? AND workspace_id = ?", created.workspaceId(), owner, deleted);
            jdbc.update("UPDATE ma_storage SET alias_key = ? WHERE alias_key = ?", "f".repeat(64), alias);
            assertWorkspaceReceiptBlocked(receipt);
            jdbc.update("UPDATE ma_storage SET alias_key = ? WHERE alias_key = ?", alias, "f".repeat(64));
        }
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt"));
    }

    @Test
    void interruptedWorkspaceCreationRemainsBlockedWithItsActualPendingReceipt() throws Exception {
        assertThatThrownBy(() -> otherWorkspaceStore("foreign", true).create("foreign", "actor", "Pending", "pending"))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"))
                .hasCauseInstanceOf(IllegalStateException.class).hasRootCauseMessage("ordinary-registration-unavailable");
        String receipt = jdbc.queryForObject("SELECT receipt_key FROM ma_request_receipt WHERE namespace = 'WORKSPACE_CREATE'", String.class);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt WHERE receipt_key = ?", String.class, receipt)).isEqualTo("PENDING");
        assertWorkspaceReceiptBlocked(receipt);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE tenant_id = ?", Integer.class, "foreign")).isZero();
    }

    @Test
    void sshWorkspaceOperationsDoNotBorrowThePassiveLocalReceiptClassification() throws Exception {
        var ssh = new SshWorkspaceStore(jdbc, new DataSourceTransactionManager(source));
        for (String tenant : List.of("tenant", "foreign")) {
            var operation = ssh.begin(tenant, "actor", "ssh-data-only", "synthetic-node", "/ordinary", "SSH");
            var before = jdbc.queryForMap("SELECT * FROM ma_operation WHERE operation_id = ?", operation.operationId());
            var found = inspect();
            assertThat(found.table("ma_operation").rows())
                    .filteredOn(row -> operation.operationId().equals(row.text("operation_id")))
                    .hasSize(1).allMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL);
            assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("ma_operation"));
            assertThat(jdbc.queryForMap("SELECT * FROM ma_operation WHERE operation_id = ?", operation.operationId()))
                    .usingRecursiveComparison().isEqualTo(before);
        }
    }

    private void assertWorkspaceReceiptBlocked(String receipt) throws Exception {
        var found = inspect();
        assertThat(found.table("ma_request_receipt").rows()).filteredOn(row -> receipt.equals(row.text("receipt_key")))
                .hasSize(1).allMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL);
        assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("ma_request_receipt"));
    }

    private ManagedWorkspaceRegistry.WorkspaceSummary createOtherWorkspace(String tenant) throws Exception {
        return otherWorkspaceStore(tenant, false).create(tenant, "actor", "Other Workspace", "other-workspace");
    }

    private WorkspaceCreationStore otherWorkspaceStore(String tenant, boolean failRegistration) throws Exception {
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve(tenant)).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        var manager = new DataSourceTransactionManager(source);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties, root -> {
            if (failRegistration) {
                throw new IllegalStateException("ordinary-registration-unavailable");
            }
            return new WorkspaceStorageGuard.Identity(root.toString(), "ordinary-test-host", "device",
                    Files.readAttributes(root, BasicFileAttributes.class).fileKey().toString(), "2026-10-16T00:00:00.123456789Z");
        });
        return new WorkspaceCreationStore(jdbc, manager, guard, new ManagedWorkspaceRegistry(jdbc),
                properties, new ObjectMapper(), Clock.systemUTC());
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
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(
                        new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime()), "tenant", intent.operationId());
                assertThat(owner.binding().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(expected, "ma_runtime_binding").bytes());
                assertThat(owner.retirement().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(expected,
                        "ma_operation").bytes());
                var dataQueries = queries.stream().filter(sql -> sql.startsWith("SELECT t.* FROM ma_")).toList();
                assertThat(dataQueries).hasSize(2);
                assertThat(dataQueries.get(0)).contains("FROM ma_operation t WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT'");
                assertThat(dataQueries.get(1)).contains("FROM ma_runtime_binding t WHERE binding_id = ?");
                assertThat(queries).anyMatch(sql -> sql.contains("INFORMATION_SCHEMA.COLUMNS"));
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(
                        new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime()), "tenant", UUID.randomUUID().toString())).isInstanceOf(IllegalArgumentException.class);
                int before = queries.size();
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(new WorkspaceCsiApplicationInventory.HistoricalScan(observed,
                        System.nanoTime() - java.util.concurrent.TimeUnit.SECONDS.toNanos(11)), "tenant", intent.operationId()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThat(queries).hasSize(before);
            } finally {
                target.rollback();
            }
        }
        jdbc.update("DELETE FROM ma_runtime_binding WHERE binding_id = ?", binding.getBindingId());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(
                        new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime()), "tenant", intent.operationId())).isInstanceOf(IllegalArgumentException.class);
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
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(read, "tenant", intent.operationId());
                WorkspaceCsiApplicationInventory.readHistoricalOwner(read, "tenant", intent.operationId());
                var current = WorkspaceCsiApplicationInventory.scanRetainedImage(read, expected, Map.of());
                assertThat(current.blockers()).isEmpty();
                assertThat(current.bytes()).isEqualTo(control.bytes());
                assertThat(current.rowCount()).isEqualTo(control.rowCount());
                assertThat(current.byteCount()).isEqualTo(control.byteCount());
                assertThat(owner.binding().bytes()).isEqualTo(WorkspaceCsiApplicationImage.sole(current, "ma_runtime_binding").bytes());
                int closingQueries = queries.size();
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.readHistoricalOwner(read, "tenant", intent.operationId()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.scanRetainedImage(read, expected, Map.of()))
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
                new WorkspaceCsiApplicationInventory.Table(table.name(), table.columns(), table.primaryKey(),
                        table.name().equals("ma_storage_owner") ? table.rows() : List.of())).toList());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var observed = observedRead(target, new java.util.ArrayList<>());
                var budget = new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime());
                var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(budget, "tenant", intent.operationId());
                var result = WorkspaceCsiApplicationInventory.scanRetainedImage(budget, empty, Map.of());
                assertThat(result.rowCount()).isEqualTo(3);
                assertThat(result.byteCount()).isEqualTo(owner.binding().bytes().length + owner.retirement().bytes().length
                        + WorkspaceCsiApplicationImage.sole(expected, "ma_storage_owner").bytes().length);
                var changed = new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime());
                WorkspaceCsiApplicationInventory.readHistoricalOwner(changed, "tenant", intent.operationId());
                // Inject a same-snapshot owned-row fault through the underlying H2 connection only.
                try (var statement = target.prepareStatement("UPDATE ma_runtime_binding SET record_version = record_version + 1 WHERE binding_id = ?")) {
                    statement.setBytes(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(binding.getBindingId()));
                    assertThat(statement.executeUpdate()).isEqualTo(1);
                }
                var refused = WorkspaceCsiApplicationInventory.scanRetainedImage(changed, expected, Map.of());
                assertThat(refused.blockers()).anyMatch(blocker -> blocker.table().equals("ma_runtime_binding")
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
        jdbc.update("UPDATE ma_tool_execution SET reference_json = ?, result_json = ? WHERE execution_call_id = ?",
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
                WorkspaceCsiApplicationInventory.readHistoricalOwner(read, "tenant", intent.operationId());
                var decoded = read.originalExecutions(original);
                assertThat(decoded).hasSize(1);
                assertThat(decoded.getFirst().getExecutionCallId()).isEqualTo(id);
                assertThat(decoded.getFirst().getResult()).containsEntry("executionStatus", "success");
                assertThat(read.originalExecutions(original).getFirst()).isSameAs(decoded.getFirst());
                var current = WorkspaceCsiApplicationInventory.scanRetainedImage(read, expected, Map.of());
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
            jdbc.update("UPDATE ma_tool_execution SET " + field.getKey() + " = ? WHERE execution_call_id = ?", field.getValue(), id);
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
            jdbc.update("UPDATE ma_tool_execution SET execution_call_id_hash = ?, reference_json = ?, result_json = ? WHERE execution_call_id = ?",
                    brokerHash(id), reference, "{\"executionStatus\":\"success\"}", id);
        }
    }

    @Test
    void foreignOwnerProjectionRetainsItsWholeHolderWithoutChangingTheSavedCodec() throws Exception {
        var image = inspect();
        var owner = WorkspaceCsiApplicationHistoryImage.owner(image);
        assertThat(owner.tables()).hasSize(image.tables().size());
        assertThat(owner.table("ma_storage_owner").rows()).hasSize(1);
        assertThat(owner.table("ma_storage_owner").rows().getFirst().bytes())
                .isEqualTo(WorkspaceCsiApplicationImage.sole(image, "ma_storage_owner").bytes());
        assertThat(owner.tables().stream().flatMap(table -> table.rows().stream()))
                .noneMatch(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.OTHER);
        assertThat(owner.table("ma_workspace").rows().getFirst().text("display_name")).isNull();
        assertThat(WorkspaceCsiApplicationInventory.restoreCanonical(owner.bytes()).bytes()).isEqualTo(owner.bytes());
    }

    @Test
    void retainedOwnerScanChecksTheWholeOriginalHolderWithoutReleasingIt() throws Exception {
        var expected = WorkspaceCsiApplicationHistoryImage.owner(inspect());
        var persisted = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]))
                .findById(binding.getBindingId());
        var original = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), 1,
                persisted.getState(), persisted.isDrainRequested(), persisted.getVersion(), null);
        var queries = new java.util.ArrayList<String>();
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime(),
                        (scan, carrier) -> { throw new AssertionError("Data component must not claim an unrelated frozen owner"); });
                var result = WorkspaceCsiApplicationInventory.readRetainedReferencedKeys(read, expected, original, intent);
                assertThat(result.blockers()).isEmpty();
                assertThat(result.bytes()).isEqualTo(expected.bytes());
                assertThat(WorkspaceCsiApplicationImage.sole(result, "ma_runtime_binding").text("binding_state"))
                        .isEqualTo("DRAINING");
                assertThat(WorkspaceCsiApplicationImage.sole(result, "ma_storage_owner").bytes())
                        .isEqualTo(WorkspaceCsiApplicationImage.sole(expected, "ma_storage_owner").bytes());
                assertThat(queries).noneMatch(sql -> sql.contains("FOR UPDATE") || !sql.startsWith("SELECT"));
            } finally {
                target.rollback();
            }
        }
        jdbc.update("UPDATE ma_storage_owner SET mount_host_id = 'changed'");
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            try {
                var read = new WorkspaceCsiApplicationInventory.HistoricalScan(observedRead(target, queries), System.nanoTime());
                var changed = WorkspaceCsiApplicationInventory.readRetainedReferencedKeys(read, expected, original, intent);
                assertThat(changed.blockers()).anyMatch(blocker -> blocker.table().equals("ma_storage_owner")
                        && blocker.code().equals("historical_row_changed"));
            } finally {
                target.rollback();
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
                List.of("ma_resource", "workspace_id", "other"),
                List.of("ma_resource", "session_scope_key", "b".repeat(64)),
                List.of("ma_resource", "sha256", "b".repeat(64)),
                List.of("ma_resource", "storage_kind", "OBJECT_STORAGE"),
                List.of("ma_resource_ref", "workspace_id", "other"),
                List.of("ma_resource_ref", "journal_revision", "32"),
                List.of("ma_session_journal_tx", "record_digest", "b".repeat(64)),
                List.of("ma_session_head", "activation_head_revision", "2"),
                List.of("ma_session_head", "activation_head_revision", "3"),
                List.of("ma_session_head", "activation_head_revision", "33"),
                List.of("ma_session_head", "activation_expires_at", "1"),
                List.of("ma_session_head", "activation_id", "other"),
                List.of("ma_session_head", "writer_id", UUID.randomUUID().toString()),
                List.of("ma_session_head", "activation_phase", "released"))) {
            var changed = nativeCellFixture(baseline, fault.get(0), fault.get(1), fault.get(2));
            assertThatThrownBy(() -> WorkspaceCsiApplicationHistory.preparedTerminal(changed, original, body))
                    .isInstanceOfAny(IllegalArgumentException.class, com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        }
        var tables = new java.util.ArrayList<>(baseline.tables());
        var references = baseline.table("ma_resource_ref");
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
        rows.put("ma_session_journal_tx", new java.util.ArrayList<>());
        rows.put("ma_resource_ref", new java.util.ArrayList<>());
        Map<String, WorkspaceCsiApplicationInventory.Row> resources = new java.util.LinkedHashMap<>();
        for (int index = 0; index < 32; index++) {
            var request = fixture.path("requests").get(index);
            var values = nativeFixtureScope(catalogue, "ma_session_journal_tx", key);
            for (var column : catalogue.table("ma_session_journal_tx").columns()) {
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
            values.put("gmt_create", "1".getBytes(StandardCharsets.UTF_8));
            rows.get("ma_session_journal_tx").add(WorkspaceCsiApplicationInventory.expectedRow(
                    "ma_session_journal_tx", values, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
            for (var resource : request.path("resources")) {
                String id = resource.path("resourceId").textValue();
                var resourceValues = nativeFixtureScope(catalogue, "ma_resource", key);
                for (var field : Map.of("session_scope_key", scope, "resource_id", id,
                        "resource_key", ManagedSessionStore.resourceKey(scope, id),
                        "kind", resource.path("kind").textValue(), "schema_version", resource.path("schemaVersion").asText(),
                        "byte_length", resource.path("byteLength").asText(), "sha256", resource.path("digest").textValue(),
                        "storage_kind", "MYSQL_INLINE", "state", "REFERENCED").entrySet()) {
                    resourceValues.put(field.getKey(), field.getValue().getBytes(StandardCharsets.UTF_8));
                }
                resourceValues.put("inline_bytes", bodies.get(id));
                resources.putIfAbsent(id, WorkspaceCsiApplicationInventory.expectedRow("ma_resource",
                        resourceValues, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
                var refValues = nativeFixtureScope(catalogue, "ma_resource_ref", key);
                refValues.put("session_scope_key", scope.getBytes(StandardCharsets.UTF_8));
                refValues.put("resource_id", id.getBytes(StandardCharsets.UTF_8));
                refValues.put("owner_kind", "JOURNAL".getBytes(StandardCharsets.UTF_8));
                refValues.put("owner_key", scope.getBytes(StandardCharsets.UTF_8));
                refValues.put("owner_revision", Integer.toString(index + 1).getBytes(StandardCharsets.UTF_8));
                refValues.put("resource_key", ManagedSessionStore.resourceKey(scope, id).getBytes(StandardCharsets.UTF_8));
                refValues.put("journal_revision", Integer.toString(index + 1).getBytes(StandardCharsets.UTF_8));
                rows.get("ma_resource_ref").add(WorkspaceCsiApplicationInventory.expectedRow(
                        "ma_resource_ref", refValues, WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
            }
        }
        rows.put("ma_resource", List.copyOf(resources.values()));
        var outputs = rows.get("ma_session_journal_tx").stream().flatMap(transaction ->
                CsiNativeActivationProof.records(transaction.binary("record_bytes")).stream())
                .map(record -> record.path("managedSession"))
                .filter(event -> "model.attempt".equals(event.path("kind").textValue())
                        && "output_committed".equals(event.path("payload").path("state").textValue())).toList();
        var first = outputs.getFirst();
        var latest = outputs.getLast();
        String projectionKey = ManagedExtensionProjection.recordKey(nativeSession, "hosted_context_usage", "latest");
        String usageId = latest.path("payload").path("usageRef").path("resourceId").textValue();
        var projection = nativeFixtureScope(catalogue, "ma_session_record", key);
        Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("record_key", projectionKey),
                Map.entry("domain", "hosted_context_usage"), Map.entry("record_id", "latest"), Map.entry("record_kind", "DOMAIN"),
                Map.entry("revision", latest.path("sequence").asText()), Map.entry("record_resource_id", usageId),
                Map.entry("gmt_create", first.path("occurredAt").asText()), Map.entry("settled_at", latest.path("occurredAt").asText()),
                Map.entry("first_sequence", first.path("sequence").asText()))
                .forEach((field, value) -> projection.put(field, value.getBytes(StandardCharsets.UTF_8)));
        rows.put("ma_session_record", List.of(WorkspaceCsiApplicationInventory.expectedRow("ma_session_record", projection,
                WorkspaceCsiApplicationInventory.Membership.ORIGINAL)));
        var derived = nativeFixtureScope(catalogue, "ma_resource_ref", key);
        Map.of("session_scope_key", scope, "owner_kind", "SESSION_RECORD", "owner_key", projectionKey,
                "owner_revision", latest.path("sequence").asText(), "resource_id", usageId,
                "resource_key", ManagedSessionStore.resourceKey(scope, usageId), "gmt_create", "1")
                .forEach((field, value) -> derived.put(field, value.getBytes(StandardCharsets.UTF_8)));
        rows.get("ma_resource_ref").add(WorkspaceCsiApplicationInventory.expectedRow("ma_resource_ref", derived,
                WorkspaceCsiApplicationInventory.Membership.ORIGINAL));
        rows.put("ma_operation", catalogue.table("ma_operation").rows());
        var head = nativeFixtureScope(catalogue, "ma_session_head", key);
        head.put("tenant_key", brokerHash(nativeTenant).getBytes(StandardCharsets.UTF_8));
        head.put("harness_key", brokerHash(nativeSession).getBytes(StandardCharsets.UTF_8));
        head.put("harness_session_id", nativeSession.getBytes(StandardCharsets.UTF_8));
        head.put("head_kind", "MANAGED_SESSION".getBytes(StandardCharsets.UTF_8));
        head.put("phase", "OPEN".getBytes(StandardCharsets.UTF_8));
        head.put("claim_generation", "0".getBytes(StandardCharsets.UTF_8));
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
        rows.put("ma_session_head", List.of(WorkspaceCsiApplicationInventory.expectedRow(
                "ma_session_head", head, WorkspaceCsiApplicationInventory.Membership.ORIGINAL)));
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
        assertThat(snapshot.tables()).hasSize(32);
        assertThat(snapshot.tables().stream().map(table -> table.columns().size()).mapToInt(Integer::intValue).sum()).isEqualTo(736);
        assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift")
                || blocker.code().equals("query_unavailable"));
        for (String table : new String[] {"ma_session", "ma_public_event", "ma_event_stream", "ma_storage", "ma_operation",
                "ma_storage_owner", "ma_runtime_binding", "ma_runtime_slot"}) {
            assertThat(snapshot.table(table).rows()).hasSize(1);
            assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals(table));
        }
        assertThat(snapshot.table("ma_request_receipt").rows()).hasSize(2);
        assertThat(snapshot.table("ma_tenant_guard").rows()).hasSize(2);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session_head")
                && blocker.code().equals("missing_or_extra_original"));
    }

    @Test
    void mainModelAndRetryColumnsRetainTheirActualTypedValues() throws Exception {
        var before = inspect();
        var owner = before.table("ma_session").rows().getFirst();
        assertThat(owner.cell("model_id").isNull()).isTrue();
        assertThat(owner.number("model_revision")).isZero();
        assertThat(before.blockers()).noneMatch(blocker -> blocker.table().equals("ma_session"));
        assertThat(before.table("ma_operation").rows().getFirst().number("budget_exempt_attempt")).isZero();
        jdbc.update("UPDATE ma_session SET model_id = ?, model_revision = 3", "reviewed-model");
        jdbc.update("UPDATE ma_operation SET budget_exempt_attempt = 7");
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, gmt_create, gmt_modified, consecutive_failures, budget_exempt_failures)"
                + " VALUES ('tenant', ?, 'turn', 'prompt', '[]', 'digest', 'COMPLETED', 1, 1, 4, 2)", session);
        var after = inspect();
        assertThat(after.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
        assertThat(after.table("ma_session").rows().getFirst().text("model_id")).isEqualTo("reviewed-model");
        assertThat(after.table("ma_session").rows().getFirst().number("model_revision")).isEqualTo(3);
        assertThat(after.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session")
                && blocker.code().equals("invalid_original_association"));
        assertThat(after.table("ma_operation").rows().getFirst().number("budget_exempt_attempt")).isEqualTo(7);
        var turn = after.table("ma_turn").rows().getFirst();
        assertThat(turn.number("consecutive_failures")).isEqualTo(4);
        assertThat(turn.number("budget_exempt_failures")).isEqualTo(2);
        assertThat(turn.cell("model_id").isNull()).isTrue();
        assertThat(turn.cell("model_revision").isNull()).isTrue();
        assertThat(after.blockers()).anyMatch(blocker -> blocker.table().equals("ma_turn"));
        assertThat(after.bytes()).isNotEqualTo(before.bytes());
        jdbc.update("UPDATE ma_session SET model_id = ?", new byte[] {(byte) 0xff});
        assertThatThrownBy(this::inspect).isInstanceOf(IllegalStateException.class)
                .hasMessage("Identity is not valid UTF-8");
    }

    @Test
    void mainPlanColumnsRetainActualValuesWithoutAdmittingPrivatePlanActivity() throws Exception {
        var before = inspect();
        var owner = before.table("ma_session").rows().getFirst();
        assertThat(owner.bool("plan_enabled")).isFalse();
        assertThat(before.blockers()).noneMatch(blocker -> blocker.table().equals("ma_session"));

        assertThatThrownBy(() -> jdbc.update("UPDATE ma_session SET plan_enabled = TRUE"))
                .isInstanceOfSatisfying(org.springframework.dao.DataAccessException.class, error ->
                        assertThat(error.getMostSpecificCause()).isInstanceOfSatisfying(java.sql.SQLException.class, sql -> {
                            assertThat(sql.getMessage()).containsIgnoringCase("ck_ma_session_plan");
                            assertThat(sql.getSQLState() + ":" + sql.getErrorCode()).isIn("23513:23513", "HY000:3819");
                        }));
        jdbc.update("UPDATE ma_session SET plan_enabled = TRUE, selected_approval_mode = 'default', approval_revision = 1");
        var enabled = inspect();
        assertThat(enabled.table("ma_session").rows().getFirst().bool("plan_enabled")).isTrue();
        assertThat(enabled.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
        assertThat(enabled.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session")
                && blocker.code().equals("invalid_original_association"));
        assertThat(enabled.table("ma_session").rows().getFirst().bytes()).isNotEqualTo(owner.bytes());

        jdbc.update("UPDATE ma_session SET plan_enabled = FALSE, selected_approval_mode = NULL, approval_revision = 0");
        var restored = inspect();
        assertThat(restored.table("ma_session").rows().getFirst().bytes()).isEqualTo(owner.bytes());
        assertThat(restored.blockers()).noneMatch(blocker -> blocker.table().equals("ma_session"));

        jdbc.update("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,payload_digest,"
                + "status,gmt_create,gmt_modified)"
                + " VALUES ('tenant',?,'turn','prompt','[]','digest','COMPLETED',1,1)", session);
        var originalTurn = inspect();
        assertThat(originalTurn.table("ma_turn").rows().getFirst().cell("plan_enabled").isNull()).isTrue();
        assertThat(originalTurn.blockers()).anyMatch(blocker -> blocker.table().equals("ma_turn"));
        jdbc.update("UPDATE ma_turn SET plan_enabled = TRUE, approval_mode = 'default', approval_revision = 1");
        var plannedTurn = inspect();
        assertThat(plannedTurn.table("ma_turn").rows().getFirst().bool("plan_enabled")).isTrue();
        assertThat(plannedTurn.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
        assertThat(plannedTurn.blockers()).anyMatch(blocker -> blocker.table().equals("ma_turn"));
        assertThat(plannedTurn.table("ma_turn").rows().getFirst().bytes())
                .isNotEqualTo(originalTurn.table("ma_turn").rows().getFirst().bytes());
    }

    @Test
    void mainApprovalSelectionColumnsRetainDefaultsAndBlockPrivatePolicyChanges() throws Exception {
        var before = inspect();
        var owner = before.table("ma_session").rows().getFirst();
        assertThat(owner.cell("selected_approval_mode").isNull()).isTrue();
        assertThat(owner.number("approval_revision")).isZero();
        assertThat(before.blockers()).noneMatch(blocker -> blocker.table().equals("ma_session"));
        jdbc.update("UPDATE ma_session SET selected_approval_mode = 'auto-edit', approval_revision = 2");
        jdbc.update("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,payload_digest,"
                + "status,gmt_create,gmt_modified,approval_mode,approval_revision)"
                + " VALUES ('tenant',?,'turn','prompt','[]','digest','COMPLETED',1,1,'default',3)", session);
        var after = inspect();
        assertThat(after.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
        assertThat(after.table("ma_session").rows().getFirst().text("selected_approval_mode")).isEqualTo("auto-edit");
        assertThat(after.table("ma_session").rows().getFirst().number("approval_revision")).isEqualTo(2);
        assertThat(after.table("ma_turn").rows().getFirst().text("approval_mode")).isEqualTo("default");
        assertThat(after.table("ma_turn").rows().getFirst().number("approval_revision")).isEqualTo(3);
        assertThat(after.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session")
                && blocker.code().equals("invalid_original_association"));
        assertThat(after.bytes()).isNotEqualTo(before.bytes());
    }

    @Test
    void extraMissingAndChangedColumnTypesBlockEvenAnEmptyUnsupportedTable() throws Exception {
        jdbc.execute("ALTER TABLE ma_session_record ADD COLUMN unexplained BIGINT");
        assertSchemaDrift();
        jdbc.execute("ALTER TABLE ma_session_record DROP COLUMN unexplained");
        alterColumn("ma_session_record", "options_json", "BIGINT");
        assertSchemaDrift();
        jdbc.execute("ALTER TABLE ma_session_record DROP COLUMN started_at");
        assertSchemaDrift();
    }

    @Test
    void taskJournalBooleanMetadataRetainsUnsupportedActivityAndExactValues() throws Exception {
        alterColumn("ma_public_event", "truncated", "BOOLEAN");
        alterColumn("ma_public_event", "archived", "BOOLEAN");
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
        jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, last_sequence, gmt_modified)"
                + " VALUES ('tenant', ?, 'TASK', 'task', 1, 1)", session);
        jdbc.update("INSERT INTO ma_public_event (tenant_id, session_id, stream_kind, stream_id, sequence_id, event_id,"
                + " event_type, gmt_create, schema_version, projection_version, truncated, archived)"
                + " VALUES ('tenant', ?, 'TASK', 'task', 1, ?, 'output', 1, 1, 1, FALSE, TRUE)", session, UUID.randomUUID().toString());
        var observed = inspect();
        assertThat(observed.blockers()).anyMatch(blocker -> blocker.table().equals("ma_public_event")
                && blocker.code().equals("unsupported_first_lane"));
        var row = observed.table("ma_public_event").rows().stream().filter(value -> "TASK".equals(value.text("stream_kind"))).findFirst().orElseThrow();
        assertThat(row.bool("truncated")).isFalse();
        assertThat(row.bool("archived")).isTrue();
        var values = new java.util.LinkedHashMap<String, byte[]>();
        row.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        values.put("archived", "2".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow(
                "ma_public_event", values, row.membership())).isInstanceOf(IllegalArgumentException.class);
        alterColumn("ma_public_event", "truncated", "VARCHAR(8)");
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.code().equals("schema_drift"));
    }

    @Test
    void aSqlFileHistoryExtensionIsBlockedWithoutBorrowingNativeProjectionSupport() throws Exception {
        jdbc.update("INSERT INTO ma_session_record"
                + " (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id,"
                + " operation_hash, revision, record_resource_id, gmt_create, first_sequence)"
                + " VALUES (?, ?, 'tenant', 'workspace', ?, 'file_history', 'history', ?, 1, 'resource', 1, 1)",
                sessionScope(), "a".repeat(64), session, "b".repeat(64));
        var snapshot = inspect();
        assertThat(snapshot.table("ma_session_record").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session_record")
                && blocker.code().equals("invalid_hosted_model_context"));
    }

    @Test
    void independentlyRetainsAnOrphanRefAndAnUnreferencedPublishedResource() throws Exception {
        byte[] bytes = "{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource"
                + " (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create)"
                + " VALUES (?, ?, 'tenant', 'workspace', ?, 'extra', 'native-fixture', 1, ?, ?, 'MYSQL_INLINE', ?,"
                + " 'publish', 'PUBLISHED', " + ManagedSchemaTime.SQL_NOW + ")", ManagedSessionStore.resourceKey(sessionScope(), "extra"), sessionScope(), session, bytes.length, sha(bytes), bytes);
        jdbc.update("INSERT INTO ma_resource_ref"
                + " (owner_kind, owner_key, owner_revision, resource_key, session_scope_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, gmt_create)"
                + " VALUES ('JOURNAL', ?, 99, ?, ?, 'foreign', 'workspace', ?, 99, 'missing', " + ManagedSchemaTime.SQL_NOW + ")",
                sessionScope(), ManagedSessionStore.resourceKey(sessionScope(), "extra"), sessionScope(), UUID.randomUUID().toString());
        var snapshot = inspect();
        assertThat(snapshot.table("ma_resource").rows()).hasSize(1);
        assertThat(snapshot.table("ma_resource_ref").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_resource_ref")
                && blocker.code().equals("invalid_original_association"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_resource"));
        assertThat(snapshot.table("ma_resource").rows().getFirst().binary("inline_bytes")).isEqualTo(bytes);
    }

    @Test
    void independentlyFindsCommandsAndDeliveriesWithNoScheduleClaimOrSessionColumn() throws Exception {
        var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.AUTOMATION;
        var scopeKind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.TENANT;
        for (String owner : List.of("tenant", "foreign")) {
            String id = owner.equals("tenant") ? "orphan" : "original-json";
            String receipt = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.receiptKey(namespace, owner, scopeKind, owner, id);
            jdbc.update("INSERT INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id, scope_kind, scope_key, scope_id,"
                    + " idempotency_key, idempotency_digest, actor_id, request_digest, schedule_id, result_json, state, gmt_create, gmt_modified)"
                    + " VALUES (?, 'AUTOMATION', ?, ?, 'TENANT', ?, ?, ?, ?, 'actor', 'digest', ?, ?, 'COMPLETED', 1, 1)",
                    receipt, brokerHash(owner), owner, WorkspaceOperations.hash("TENANT", owner), owner, id, brokerHash(id),
                    owner.equals("tenant") ? "" : "unknown", owner.equals("tenant") ? "{}" : "{\"sessionId\":\"" + session + "\"}");
        }
        String channelScope = WorkspaceOperations.hash("tenant", "channel");
        jdbc.update("INSERT INTO ma_delivery (delivery_key, delivery_kind, tenant_id, channel_id, delivery_id, source_scope_key,"
                + " segment_id, segment_ordinal, transport_state, reception_state, consumption_state, payload_json, gmt_create, gmt_modified)"
                + " VALUES (?, 'CHANNEL', 'tenant', 'channel', 'delivery', ?, 'segment', 0, 'RETURNED', 'PENDING', 'PENDING', '{}', 1, 1)",
                WorkspaceOperations.hash("CHANNEL", channelScope, "delivery"), channelScope);
        var snapshot = inspect();
        assertThat(snapshot.table("ma_request_receipt").rows().stream().filter(row -> "AUTOMATION".equals(row.text("namespace"))))
                .hasSize(2);
        assertThat(snapshot.table("ma_delivery").rows()).hasSize(1);
        for (String table : List.of("ma_request_receipt", "ma_delivery")) {
            assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals(table)
                    && blocker.code().equals("unresolved_candidate_owner"));
        }
    }

    @Test
    void fullTypedBytesAreStableImmutableAndIncludeEveryChangedField() throws Exception {
        var before = inspect();
        var replay = inspect();
        assertThat(replay.bytes()).isEqualTo(before.bytes());
        var parent = before.table("ma_session").rows().getFirst();
        byte[] actor = parent.binary("creator_actor_key");
        actor[0] ^= 1;
        byte[] encoded = parent.bytes();
        encoded[0] ^= 1;
        byte[] snapshotBytes = before.bytes();
        snapshotBytes[0] ^= 1;
        assertThat(replay.bytes()).isEqualTo(before.bytes());
        assertThat(parent.binary("creator_actor_key")).isNotEqualTo(actor);
        assertThat(parent.bytes()).isNotEqualTo(encoded);
        jdbc.update("UPDATE ma_session SET approval_mode = 'default' WHERE session_id = ?", session);
        var changed = inspect();
        assertThat(changed.bytes()).isNotEqualTo(before.bytes());
        assertThat(changed.table("ma_session").rows().getFirst().text("approval_mode")).isEqualTo("default");
        assertThat(before.table("ma_session").rows().getFirst().text("approval_mode")).isEqualTo("yolo");
    }

    @Test
    void foreignCaptureWithoutItsActualSessionOwnerIsRetainedAsABlocker() throws Exception {
        String foreignSession = "missing-foreign-session";
        String foreignScope = ToolPublicationDataStore.scope("tenant", "workspace", foreignSession);
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes) VALUES (?, ?, 'tenant', 'workspace', ?,"
                + " 'foreign-publication', ?, 'foreign-capture', '{}', ?, ?, 'FENCED', 0, 0, 0)",
                foreignScope, ToolPublicationRetentionStore.hash("tenant"), foreignSession,
                "a".repeat(64), "b".repeat(64), "c".repeat(64));
        var snapshot = inspect();
        assertThat(snapshot.table("ma_output_capture").rows()).hasSize(1);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_output_capture")
                && blocker.code().equals("unresolved_candidate_owner"));
    }

    @Test
    void aggregateRowOverflowCannotBeHiddenByUnsupportedOrRepeatedRows() throws Exception {
        actionBatch("tenant", session, WorkspaceCsiApplicationInventory.MAX_ROWS + 1);
        var snapshot = inspect();
        assertThat(snapshot.rowCount()).isLessThanOrEqualTo(WorkspaceCsiApplicationInventory.MAX_ROWS);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("row_limit"));
    }

    @Test
    void anOversizedBinaryColumnBlocksBeforeItCanBecomeACut() throws Exception {
        byte[] bytes = new byte[WorkspaceCsiApplicationInventory.MAX_BYTES + 1];
        jdbc.update("UPDATE ma_operation SET frozen_request_bytes = ?, frozen_request_sha256 = ?",
                bytes, sha(bytes));
        var snapshot = inspect();
        assertThat(snapshot.byteCount()).isLessThanOrEqualTo(WorkspaceCsiApplicationInventory.MAX_BYTES);
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.code().equals("byte_limit"));
    }

    @Test
    void nonzeroNativeHistoryExecutionsAndReadsRemainCompleteAcrossAllStates() throws Exception {
        byte[] resource = "{\"schemaVersion\":1,\"data\":\"complete bytes\"}".getBytes(StandardCharsets.UTF_8);
        byte[] record = "{\"sequence\":1,\"resourceId\":\"resource\"}\n".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, head_kind, harness_session_id, tenant_id, workspace_id, session_id, storage_version,"
                + " state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision,"
                + " committed_sequence, last_commit_digest, activation_epoch, compacted_through_revision, recovery_status,"
                + " gmt_create, gmt_modified, activation_id) VALUES (?, ?, 'MANAGED_SESSION', ?, 'tenant', 'workspace', ?, 1, 'ACTIVE', 1, 'writer',"
                + " " + ManagedSchemaTime.SQL_NOW + ", ?, 1, 1, ?, 1, 0, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ", 'activation')",
                brokerHash("tenant"), brokerHash(session), session, session, "a".repeat(64), "b".repeat(64));
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence,"
                + " event_count, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                + " record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                + " VALUES ('tenant', 'workspace', ?, 1, ?, 'transaction', 'fixture', 'command', ?, 1, 1, 1, ?, 1,"
                + " 'writer', ?, 1, 'identity', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                session, "c".repeat(64), "d".repeat(64), "b".repeat(64), "a".repeat(64), record, record.length, sha(record));
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                + " state, gmt_create) VALUES (?, ?, 'tenant', 'workspace', ?, 'resource', 'inventory-fixture', 1, ?, ?,"
                + " 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(sessionScope(), "resource"), sessionScope(), session, resource.length, sha(resource), resource);
        jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_key, owner_revision, resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                + " journal_revision, resource_id, gmt_create) VALUES ('JOURNAL', ?, 1, ?, ?, 'tenant', 'workspace', ?, 1, 'resource', " + ManagedSchemaTime.SQL_NOW + ")",
                sessionScope(), ManagedSessionStore.resourceKey(sessionScope(), "resource"), sessionScope(), session);
        for (String state : List.of("PREPARED", "DISPATCHING", "EXECUTING", "CANCEL_REQUESTED", "UNKNOWN", "ABANDONED", "SETTLED")) {
            insertExecution(state, state, binding.getBindingId(), session, brokerHash(session));
        }
        insertExecution("foreign", "SETTLED", "foreign-binding", "foreign-session", brokerHash(session));
        for (String state : List.of("OPEN", "UNKNOWN", "RETURNED")) {
            insertReadReceipt(UUID.randomUUID().toString(), state, "inventory-fixture", resource.length, sha(resource),
                    "activation", 3, "RETURNED".equals(state) ? 2L : null,
                    "RETURNED".equals(state) ? "verified" : "UNKNOWN".equals(state) ? "jdbc_fetch_unknown" : null);
        }
        var snapshot = inspect();
        for (String table : List.of("ma_session_head", "ma_session_journal_tx",
                "ma_resource", "ma_resource_ref")) {
            assertThat(snapshot.table(table).rows()).hasSize(1);
            assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals(table));
        }
        assertThat(snapshot.table("ma_session_journal_tx").rows().getFirst().binary("record_bytes")).isEqualTo(record);
        assertThat(snapshot.table("ma_resource").rows().getFirst().binary("inline_bytes")).isEqualTo(resource);
        assertThat(snapshot.table("ma_tool_execution").rows()).hasSize(8);
        assertThat(snapshot.table("ma_request_receipt").rows().stream()
                .filter(row -> "CSI_RESOURCE_READ".equals(row.text("operation")))).hasSize(3);
        var settled = snapshot.table("ma_tool_execution").rows().stream()
                .filter(row -> row.text("execution_call_id").equals("SETTLED")).findFirst().orElseThrow();
        assertThat(settled.fields()).hasSize(28);
        assertThat(settled.text("native_authorization_json")).isEqualTo("{}");
        assertThat(settled.key()).containsExactly(settled.cell("execution_call_id_hash"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_tool_execution"));
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_request_receipt"));
        assertThat(snapshot.rowCount()).isEqualTo(snapshot.tables().stream().mapToInt(table -> table.rows().size()).sum());
        assertThat(snapshot.byteCount()).isEqualTo(snapshot.tables().stream()
                .flatMap(table -> table.rows().stream()).mapToLong(row -> row.bytes().length).sum());
        assertThat(inspect().bytes()).isEqualTo(snapshot.bytes());
    }

    @Test
    void legacyNullProgressBlocksAndEveryProgressTailChangesTheCapturedBytes() throws Exception {
        var before = inspect();
        jdbc.update("UPDATE ma_operation SET progress_stage = NULL");
        var legacy = inspect();
        assertThat(legacy.blockers()).anyMatch(blocker -> blocker.table().equals("ma_operation")
                && blocker.code().equals("invalid_original_association"));
        assertThat(legacy.bytes()).isNotEqualTo(before.bytes());
        jdbc.update("UPDATE ma_operation SET progress_stage = 'FROZEN', progress_version = progress_version + 1,"
                + " frozen_request_bytes = ?, frozen_request_sha256 = ?", new byte[] {1, 2}, sha(new byte[] {1, 2}));
        var frozen = inspect();
        assertThat(frozen.bytes()).isNotEqualTo(legacy.bytes());
        assertThat(frozen.table("ma_operation").rows().getFirst().binary("frozen_request_bytes"))
                .isEqualTo(new byte[] {1, 2});
    }

    @Test
    void changedPhysicalRegistrationCannotHideBehindUnchangedAliasAndRevision() throws Exception {
        var saved = (com.fasterxml.jackson.databind.node.ObjectNode) new ObjectMapper().readTree(
                jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class));
        saved.put("volumeHandle", "replacement");
        jdbc.update("UPDATE ma_storage SET registration_json = ?", saved.toString());
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("ma_storage")
                && blocker.code().equals("invalid_original_association"));
    }

    @Test
    void equivalentHandleJsonRetainsExactRawBytesButRefusesChangedOrAmbiguousObjects() throws Exception {
        var before = inspect();
        assertThat(before.blockers()).noneMatch(blocker -> blocker.table().equals("ma_runtime_binding"));
        String raw = WorkspaceCsiApplicationImage.sole(before, "ma_runtime_binding").text("resource_handle_json");
        String equivalent = " \n" + raw.replace(":", " : ") + "\n ";
        jdbc.update("UPDATE ma_runtime_binding SET resource_handle_json = ? WHERE binding_id = ?", equivalent, binding.getBindingId());
        var observed = inspect();
        assertThat(observed.blockers()).noneMatch(blocker -> blocker.table().equals("ma_runtime_binding"));
        assertThat(WorkspaceCsiApplicationImage.sole(observed, "ma_runtime_binding").text("resource_handle_json"))
                .isEqualTo(equivalent);
        assertThat(observed.bytes()).isNotEqualTo(before.bytes());
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.verify(
                WorkspaceCsiApplicationInventory.expectedImage(observed.tables()),
                WorkspaceCsiApplicationInventory.expectedImage(before.tables()))).isInstanceOf(IllegalArgumentException.class);
        for (String invalid : List.of(raw.replace("fixture-original", "changed"),
                raw.substring(0, raw.length() - 1) + ",\"podUid\":\"fixture-original\"}", raw + "{}")) {
            jdbc.update("UPDATE ma_runtime_binding SET resource_handle_json = ? WHERE binding_id = ?", invalid, binding.getBindingId());
            assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("ma_runtime_binding")
                    && blocker.code().equals("invalid_original_association"));
        }
    }

    @Test
    void unrelatedGlobalDefinitionsAreNotOriginalWorkForTheOpaqueSelectedRevision() throws Exception {
        jdbc.update("INSERT INTO ma_agent_definition (tenant_id, agent_id, revision, digest, definition_json, gmt_create)"
                + " VALUES ('tenant', 'qwen-code', 7, 'digest', '{}', 1)");
        var snapshot = inspect();
        assertThat(snapshot.table("ma_agent_definition").rows()).isEmpty();
        assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.table().equals("ma_agent_definition"));
    }

    @Test
    void rowsUseTheWholeFinalPrimaryKeyAndSortNumericComponentsNumerically() throws Exception {
        for (long sequence : new long[] {10, 2}) {
            jdbc.update("INSERT INTO ma_public_event (tenant_id, session_id, sequence_id, event_id, event_type, data_json,"
                    + " terminal, gmt_create) VALUES ('tenant', ?, ?, ?, 'fixture', '{}', FALSE, 1)",
                    session, sequence, UUID.randomUUID().toString());
        }
        var snapshot = inspect();
        var table = snapshot.table("ma_public_event");
        assertThat(table.primaryKey()).containsExactly("tenant_id", "session_id", "stream_kind", "stream_id", "sequence_id");
        assertThat(table.rows()).extracting(row -> row.number("sequence_id")).containsExactly(1L, 2L, 10L);
        for (var row : table.rows()) {
            assertThat(row.key()).containsExactly(row.cell("tenant_id"), row.cell("session_id"), row.cell("stream_kind"), row.cell("stream_id"), row.cell("sequence_id"));
            assertThat(row.fields()).hasSize(table.columns().size());
        }
        assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_public_event"));
    }

    @Test
    void samePrimaryKeyWithChangedWholeBytesBlocksDuringTheFixedPoint() throws Exception {
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            var attempts = new AtomicInteger();
            var wrapped = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, arguments) -> {
                        if (method.getName().equals("prepareStatement") && arguments != null
                                && arguments[0] instanceof String sql && sql.startsWith("SELECT t.* FROM ma_session t")
                                && attempts.incrementAndGet() == 2) {
                            try (var statement = target.prepareStatement("UPDATE ma_session SET approval_mode = 'changed'")) {
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
                assertThat(snapshot.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session")
                        && blocker.code().equals("same_key_conflicting_bytes"));
                assertThat(snapshot.table("ma_session").rows()).hasSize(1);
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
        assertThat(restored.tables()).hasSize(32);
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
        var row = inspect().table("ma_session").rows().getFirst();
        Map<String, byte[]> values = new java.util.LinkedHashMap<>();
        row.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
        for (String invalid : List.of("01", "1.0", "+1", "9223372036854775808")) {
            var changed = new java.util.LinkedHashMap<>(values);
            changed.put("workspace_generation", invalid.getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("ma_session", changed, row.membership()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        var changed = new java.util.LinkedHashMap<>(values);
        changed.put("csi_guard", "1".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("ma_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.put("csi_guard", values.get("csi_guard"));
        changed.put("session_id", null);
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("ma_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.put("session_id", new byte[] {(byte) 0xc3, 0x28});
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("ma_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
        changed.remove("approval_mode");
        assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.expectedRow("ma_session", changed, row.membership()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void timestampCellsPreserveCanonicalEpochMillisecondsAndNulls() throws Exception {
        for (long value : new long[] {0L, Instant.parse("2040-01-01T00:00:00.123Z").toEpochMilli(),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.NEVER_DUE_MILLIS}) {
            jdbc.update("UPDATE ma_session SET gmt_create = ?, gmt_modified = ?", value, value);
            var snapshot = inspect();
            var row = snapshot.table("ma_session").rows().getFirst();
            assertThat(row.number("gmt_create")).isEqualTo(value);
            assertThat(row.cell("gmt_create").bytes()).isEqualTo(Long.toString(value).getBytes(StandardCharsets.UTF_8));
            assertThat(row.cell("deleted_at").isNull()).isTrue();
            assertThat(snapshot.blockers()).noneMatch(blocker -> blocker.code().equals("schema_drift"));
            assertThat(WorkspaceCsiApplicationInventory.expectedImage(snapshot.tables()).table("ma_session").rows().getFirst().bytes())
                    .isEqualTo(row.bytes());
        }
        alterColumn("ma_agent_definition", "gmt_create", "TIMESTAMP");
        assertSchemaDrift();
    }

    @Test
    void cutImageWritesExactMillisecondCellsAndRejectsSubmillisecondTime() throws Exception {
        var json = new ObjectMapper();
        com.fasterxml.jackson.databind.JsonNode fixture;
        try (var input = getClass().getResourceAsStream("/csi-native-text-fixture.json")) {
            fixture = json.readTree(input);
        }
        var original = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var nativeRows = preparedNativeFixture(original, fixture);
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(original.tables().stream().map(table ->
                List.of("ma_session_head", "ma_session_journal_tx", "ma_resource", "ma_resource_ref").contains(table.name())
                        ? nativeRows.table(table.name()) : table).toList());
        byte[] body = json.writeValueAsBytes(fixture.path("requests").get(32));
        var envelope = json.createObjectNode().put("commitBodyBase64", java.util.Base64.getEncoder().encodeToString(body))
                .put("preparedCommitSha256", sha(body)).put("baselineBase64", java.util.Base64.getEncoder().encodeToString(baseline.bytes()))
                .put("writerTokenSha256", "a".repeat(64));
        byte[] frozen = json.writeValueAsBytes(envelope);
        String writtenAt = "2040-01-01T00:00:00.123Z";
        var delta = json.createObjectNode().put("format", "qwen-csi-application-cut/1")
                .put("retirementId", baseline.table("ma_operation").rows().getFirst().text("operation_id"))
                .put("frozenRequestSha256", sha(frozen)).put("baselineSha256", sha(baseline.bytes()))
                .put("preparedCommitSha256", sha(body)).put("writtenAt", writtenAt);
        var image = WorkspaceCsiApplicationImage.expected(baseline,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.CUT, frozen, json.writeValueAsBytes(delta), null);
        long millis = Instant.parse(writtenAt).toEpochMilli();
        assertThat(image.table("ma_session_head").rows().getFirst().number("gmt_modified")).isEqualTo(millis);
        for (String table : List.of("ma_resource", "ma_resource_ref", "ma_session_journal_tx")) {
            var added = image.table(table).rows().stream().filter(row -> row.number("gmt_create") != null
                    && row.number("gmt_create") == millis).toList();
            assertThat(added).hasSize(1);
            assertThat(image.table(table).rows()).hasSize(baseline.table(table).rows().size() + 1);
            if (table.equals("ma_resource")) {
                assertThat(added.getFirst().number("last_verified_at")).isEqualTo(millis);
            }
        }
        delta.put("writtenAt", "2040-01-01T00:00:00.123001Z");
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.expected(baseline,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.CUT, frozen, json.writeValueAsBytes(delta), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void frozenExpectedImageAllowsOnlyTheDeclaredProgressDelta() throws Exception {
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        byte[] frozen = "{\"saved\":true}".getBytes(StandardCharsets.UTF_8);
        var expected = WorkspaceCsiApplicationImage.expected(baseline,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.FROZEN, frozen, null, null);
        var progress = expected.table("ma_operation").rows().getFirst();
        assertThat(progress.text("progress_stage")).isEqualTo("FROZEN");
        assertThat(progress.number("progress_version")).isEqualTo(2);
        assertThat(progress.binary("frozen_request_bytes")).isEqualTo(frozen);
        assertThat(progress.text("frozen_request_sha256")).isEqualTo(sha(frozen));
        for (var table : baseline.tables()) {
            if (!table.name().equals("ma_operation")) {
                assertThat(expected.table(table.name()).rows().stream().map(WorkspaceCsiApplicationInventory.Row::bytes).toList())
                        .containsExactlyElementsOf(table.rows().stream().map(WorkspaceCsiApplicationInventory.Row::bytes).toList());
            }
        }
        jdbc.update("UPDATE ma_operation SET progress_stage = 'FROZEN', progress_version = 2,"
                + " frozen_request_bytes = ?, frozen_request_sha256 = ?", frozen, sha(frozen));
        var actual = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        WorkspaceCsiApplicationImage.verify(actual, expected);
        jdbc.update("UPDATE ma_session SET gmt_modified = gmt_modified + 1");
        var drift = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.verify(drift, expected)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WorkspaceCsiApplicationImage.expected(actual,
                com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.FROZEN, frozen, null, null))
                .isInstanceOf(IllegalArgumentException.class);
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
        jdbc.update("INSERT INTO ma_tool_execution (execution_call_id_hash, execution_call_id, idempotency_key_hash, idempotency_key,"
                + " binding_id, runtime_generation, harness_session_id, runtime_session_id, runtime_session_key, turn_id, tool_call_id,"
                + " request_digest, reference_json, execution_state, execution_status, result_json, last_sequence, cancel_requested,"
                + " dispatch_generation, record_version, settled_at, native_authorization_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                + " 'turn', 'call', 'digest', '{}', ?, 'success', '{}', 1, FALSE, 1, 1, " + ManagedSchemaTime.SQL_NOW + ", '{}')",
                brokerHash(id), id, brokerHash("idempotency-" + id), "idempotency-" + id, bindingId, binding.getGeneration(),
                runtimeSession, runtimeSession, runtimeKey, state);
    }

    private static String brokerHash(String text) {
        byte[] value = text.getBytes(StandardCharsets.UTF_8);
        return sha(java.nio.ByteBuffer.allocate(Integer.BYTES + value.length).putInt(value.length).put(value).array());
    }

    private static String actionSql() {
        return "INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, session_id, domain, record_id,"
                + " revision, gmt_create, record_kind, state, action_id, action_version, options_json)"
                + " VALUES (?, ?, ?, ?, 'action', ?, 1, 1, 'ACTION', 'COMPLETED', ?, 1, ?)";
    }

    private static void bindAction(java.sql.PreparedStatement statement, String tenant, String session,
            String id, String payload) throws java.sql.SQLException {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        statement.setString(1, scope);
        statement.setString(2, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, "ACTION", id));
        statement.setBytes(3, tenant.getBytes(StandardCharsets.UTF_8));
        statement.setBytes(4, session.getBytes(StandardCharsets.UTF_8));
        statement.setBytes(5, id.getBytes(StandardCharsets.UTF_8));
        statement.setBytes(6, id.getBytes(StandardCharsets.UTF_8));
        statement.setString(7, payload);
    }

    private void action(String tenant, String session, String id, String payload) throws Exception {
        try (var target = source.getConnection(); var statement = target.prepareStatement(actionSql())) {
            bindAction(statement, tenant, session, id, payload);
            assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }

    private void actionBatch(String tenant, String session, int count) throws Exception {
        try (var target = source.getConnection(); var statement = target.prepareStatement(actionSql())) {
            for (int index = 0; index < count; index++) {
                bindAction(statement, tenant, session, String.format("%05d", index), "{}");
                statement.addBatch();
            }
            statement.executeBatch();
        }
    }

    void alterColumn(String table, String column, String type) {
        jdbc.execute("ALTER TABLE " + table + " ALTER COLUMN " + column + " " + type);
    }

    private void assertSchemaDrift() throws Exception {
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.code().equals("schema_drift"));
    }

    @Test
    void fixedKeyReaderPreservesTypedBytesAndTheOriginalDrainingHolderWithoutLocking() throws Exception {
        var expected = historicalKeys();
        var queries = new java.util.ArrayList<String>();
        var result = readKeys(expected, queries);
        assertThat(result.blockers()).isEmpty();
        assertThat(result.bytes()).isEqualTo(expected.bytes());
        assertThat(queries.stream().filter(sql -> sql.startsWith("SELECT t.* FROM ma_"))).hasSize(32);
        assertThat(queries).noneMatch(sql -> sql.contains("FOR UPDATE"));
        assertThat(queries).anyMatch(sql -> sql.startsWith("SELECT t.* FROM ma_storage_owner t WHERE") && sql.contains("storage_key = ?"));
        assertThat(queries).noneMatch(sql -> sql.contains("physical_key = ?"));
        assertThat(result.table("ma_request_receipt").rows().getFirst().binary("actor_id"))
                .isEqualTo(expected.table("ma_request_receipt").rows().getFirst().binary("actor_id"));
    }

    @Test
    void fixedKeyReaderRefusesChangedAndMissingOriginalRows() throws Exception {
        var expected = historicalKeys();
        jdbc.update("UPDATE ma_session SET approval_mode = 'changed' WHERE tenant_id = X'74656e616e74' AND session_id = ?", session);
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("ma_session") && blocker.code().equals("historical_row_changed"));
        jdbc.update("DELETE FROM ma_public_event WHERE tenant_id = X'74656e616e74' AND session_id = ?", session);
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("ma_public_event") && blocker.code().equals("missing_historical_key"));
    }

    @Test
    void fixedContextMasksIgnoreDisplayNameAndRefuseOriginalConfigurationChanges() throws Exception {
        var expected = historicalKeys();
        jdbc.update("UPDATE ma_workspace SET display_name = 'renamed' WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        assertThat(readKeys(expected, new java.util.ArrayList<>()).bytes()).isEqualTo(expected.bytes());
        jdbc.update("UPDATE ma_workspace SET policy_ref = 'changed' WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        assertThat(readKeys(expected, new java.util.ArrayList<>()).blockers()).anyMatch(blocker ->
                blocker.table().equals("ma_workspace") && blocker.code().equals("historical_row_changed"));
        assertThatThrownBy(() -> WorkspaceCsiApplicationHistoryImage.context("ma_public_event",
                expected.table("ma_public_event").rows().getFirst())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fixedKeyReaderChecksEmptyTableSchemasAndRefusesMutableConnectionsBeforeSql() throws Exception {
        var expected = historicalKeys();
        jdbc.execute("ALTER TABLE ma_session_record ADD COLUMN unexpected BIGINT");
        assertThatThrownBy(() -> readKeys(expected, new java.util.ArrayList<>()))
                .isInstanceOf(java.sql.SQLException.class).hasMessageContaining("ma_session_record");
        jdbc.execute("ALTER TABLE ma_session_record DROP COLUMN unexpected");
        try (var target = source.getConnection()) {
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.scanRetainedImage(
                            new WorkspaceCsiApplicationInventory.HistoricalScan(target, System.nanoTime()), expected, Map.of()))
                    .isInstanceOf(IllegalArgumentException.class);
            target.setAutoCommit(false);
            assertThatThrownBy(() -> WorkspaceCsiApplicationInventory.scanRetainedImage(
                            new WorkspaceCsiApplicationInventory.HistoricalScan(target, System.nanoTime()), expected, Map.of()))
                    .isInstanceOf(IllegalArgumentException.class);
            target.rollback();
        }
    }

    @Test
    void historicalReaderPreservesActualForeignControlSessionWithSameLocalId() throws Exception {
        var expected = historicalKeys();
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        transactions.executeWithoutResult(status -> ToolPublicationRetentionStore.lockSession(jdbc, "foreign", session));
        var before = jdbc.queryForList("SELECT * FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                "foreign".getBytes(StandardCharsets.UTF_8), session.getBytes(StandardCharsets.UTF_8));
        var queries = new java.util.ArrayList<String>();
        var result = readHistory(expected, queries, true);
        assertThat(result.blockers()).isEmpty();
        assertThat(result.bytes()).isEqualTo(expected.bytes());
        assertThat(queries).anyMatch(sql -> sql.contains("(tenant_id IN (?) AND session_id IN (?))"));
        assertThat(jdbc.queryForList("SELECT * FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                "foreign".getBytes(StandardCharsets.UTF_8), session.getBytes(StandardCharsets.UTF_8)))
                .usingRecursiveComparison().isEqualTo(before);
    }

    @Test
    void referencedReaderFindsExtraTypedOwnersWithoutAddingTheirRowsToTheOriginalImage() throws Exception {
        var expected = historicalKeys();
        assertThat(readReferences(expected).blockers()).isEmpty();
        new TransactionTemplate(new DataSourceTransactionManager(source)).executeWithoutResult(status ->
                ToolPublicationRetentionStore.lockSession(jdbc, "foreign", session));
        action("foreign", session, "late", "{}");
        assertThat(readReferences(expected).blockers()).isEmpty();
        action("tenant", session, "late-original", "{}");
        var result = readReferences(expected);
        assertThat(result.blockers()).anyMatch(blocker -> blocker.table().equals("ma_session_record")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(result.table("ma_session_record").rows()).isEmpty();
        assertThat(result.rowCount()).isGreaterThan(expected.rowCount());
    }

    @Test
    void referencedReaderStrictlyDecodesForeignJsonAndEscapedReferenceNames() throws Exception {
        var expected = historicalKeys();
        action("foreign", "new-session", "candidate", "{}");
        String escaped = "{\"nested\":[{\"session\\u0049d\":\"" + session.replace("-", "\\u002d") + "\"}]}";
        for (String json : List.of(escaped, "{", "{\"sessionId\":\"" + session + "\",\"sessionId\":\"new-session\"}", "{} {}")) {
            jdbc.update("UPDATE ma_session_record SET options_json = ? WHERE action_id = X'63616e646964617465'", json);
            assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("ma_session_record")
                    && (blocker.code().equals("extra_historical_reference") || blocker.code().equals("invalid_historical_payload")));
        }
        jdbc.update("UPDATE ma_session_record SET options_json = ? WHERE action_id = X'63616e646964617465'",
                "{\"text\":\"" + session + "\",\"payloadJson\":\"{\\\"sessionId\\\":\\\"" + session + "\\\"}\"}");
        assertThat(readReferences(expected).blockers()).isEmpty();
    }

    @Test
    void referencedReaderChecksInlineMetadataAndKeepsResourceIdsLocalToTheirOwner() throws Exception {
        var expected = historicalKeys();
        byte[] harmless = "{\"cwd\":\"/workspace\"}".getBytes(StandardCharsets.UTF_8);
        foreignResource("same-local-id", "managed-root", harmless);
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE ma_resource SET sha256 = ? WHERE resource_id = X'73616d652d6c6f63616c2d6964'", "0".repeat(64));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE ma_resource SET sha256 = ?, kind = 'unknown-format' WHERE resource_id = X'73616d652d6c6f63616c2d6964'", sha(harmless));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("unsupported_historical_payload"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"message", "tool-outcome"})
    void referencedReaderReassemblesSplitUtf8BeforeCheckingReferences(String format) throws Exception {
        var expected = historicalKeys();
        byte[] body = new ObjectMapper().createObjectNode().put("padding", "a" + "\uD83D\uDE00".repeat(18000))
                .put("sessionId", session).toString().getBytes(StandardCharsets.UTF_8);
        byte[] first = java.util.Arrays.copyOfRange(body, 0, 60 * 1024);
        byte[] last = java.util.Arrays.copyOfRange(body, first.length, body.length);
        assertThatThrownBy(() -> StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(first))).isInstanceOf(java.nio.charset.CharacterCodingException.class);
        foreignResource("a-part", "managed-" + format + "-part", first);
        foreignResource("b-part", "managed-" + format + "-part", last);
        var manifest = new ObjectMapper().createObjectNode();
        var parts = manifest.putArray("parts");
        for (var entry : Map.of("a-part", first, "b-part", last).entrySet().stream().sorted(Map.Entry.comparingByKey()).toList()) {
            parts.addObject().put("resourceId", entry.getKey()).put("kind", "managed-" + format + "-part").put("schemaVersion", 1)
                    .put("byteLength", entry.getValue().length).put("digest", sha(entry.getValue()));
        }
        foreignResource("z-manifest", "managed-" + format + "-chunks", manifest.toString().getBytes(StandardCharsets.UTF_8));
        var found = readReferences(expected);
        assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("ma_resource")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(found.blockers()).noneMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        byte[] unrelated = new ObjectMapper().createObjectNode().put("padding", "a" + "\uD83D\uDE00".repeat(18000))
                .put("sessionId", "foreign-session").toString().getBytes(StandardCharsets.UTF_8);
        jdbc.update("DELETE FROM ma_resource");
        byte[] end = java.util.Arrays.copyOfRange(unrelated, first.length, unrelated.length);
        foreignResource("a-part", "managed-" + format + "-part", first);
        foreignResource("b-part", "managed-" + format + "-part", end);
        ((com.fasterxml.jackson.databind.node.ObjectNode) parts.get(1)).put("byteLength", end.length).put("digest", sha(end));
        foreignResource("z-manifest", "managed-" + format + "-chunks", manifest.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(readReferences(expected).blockers()).isEmpty();
        byte[] validManifest = manifest.toString().getBytes(StandardCharsets.UTF_8);
        parts.set(1, parts.get(0).deepCopy());
        byte[] repeated = manifest.toString().getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE resource_id = X'7a2d6d616e6966657374'",
                repeated, repeated.length, sha(repeated));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE resource_id = X'7a2d6d616e6966657374'",
                validManifest, validManifest.length, sha(validManifest));
        jdbc.update("UPDATE ma_resource SET tenant_id = 'changed' WHERE resource_id = X'612d70617274'");
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE ma_resource SET tenant_id = 'foreign' WHERE resource_id = X'612d70617274'");
        jdbc.update("DELETE FROM ma_resource WHERE resource_id = X'7a2d6d616e6966657374'");
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    @Test
    void liveInventoryExpandsCompleteOutcomeBytesAndRefusesAnOrphanPart() throws Exception {
        byte[] body = new ObjectMapper().createObjectNode().put("padding", "a" + "\uD83D\uDE00".repeat(18000))
                .put("sessionId", session).toString().getBytes(StandardCharsets.UTF_8);
        byte[] first = java.util.Arrays.copyOfRange(body, 0, 60 * 1024);
        byte[] last = java.util.Arrays.copyOfRange(body, first.length, body.length);
        var manifest = new ObjectMapper().createObjectNode();
        var parts = manifest.putArray("parts");
        for (var entry : Map.of("a-part", first, "b-part", last).entrySet().stream().sorted(Map.Entry.comparingByKey()).toList()) {
            parts.addObject().put("resourceId", entry.getKey()).put("kind", "managed-tool-outcome-part").put("schemaVersion", 1)
                    .put("byteLength", entry.getValue().length).put("digest", sha(entry.getValue()));
            nativeChunkResource(entry.getKey(), "managed-tool-outcome-part", entry.getValue());
        }
        nativeChunkResource("z-manifest", "managed-tool-outcome-chunks", manifest.toString().getBytes(StandardCharsets.UTF_8));
        var complete = inspect();
        assertThat(complete.table("ma_resource").rows()).hasSize(3);
        assertThat(complete.blockers()).noneMatch(blocker -> blocker.code().equals("malformed_native_resource")
                || blocker.code().equals("invalid_native_chunks"));
        jdbc.update("DELETE FROM ma_resource WHERE resource_id = X'7a2d6d616e6966657374'");
        assertThat(inspect().blockers()).anyMatch(blocker -> blocker.table().equals("ma_resource")
                && blocker.code().equals("invalid_original_association"));
    }

    private void nativeChunkResource(String id, String kind, byte[] bytes) {
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,"
                        + "kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,publish_command_id,state,gmt_create)"
                        + " VALUES (?,?,'tenant','workspace',?,?,?,1,?,?,'MYSQL_INLINE',?,'publish','REFERENCED'," + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(sessionScope(), id), sessionScope(), session, id, kind, bytes.length, sha(bytes), bytes);
    }

    private void foreignResource(String id, String kind, byte[] bytes) {
        String scope = ManagedSessionStore.sessionScopeKey("foreign", "foreign-session");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id,"
                + " kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create)"
                + " VALUES (?, ?, 'foreign', 'other-workspace', 'foreign-session', ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'publish', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(scope, id), scope, id, kind, bytes.length, sha(bytes), bytes);
    }

    @Test
    void referencedReaderSharesNativeInputArrayContract() throws Exception {
        var expected = historicalKeys();
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
        jdbc.update("UPDATE ma_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE resource_id = X'666f726569676e2d696e707574'",
                literal, literal.length, sha(literal));
        assertThat(readReferences(expected).blockers()).isEmpty();
        for (byte[] malformed : List.of("{}".getBytes(StandardCharsets.UTF_8), "[]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"image\",\"text\":\"x\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":null}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\",\"extra\":true}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\",\"text\":\"y\"}]".getBytes(StandardCharsets.UTF_8),
                "[{\"type\":\"text\",\"text\":\"x\"}] []".getBytes(StandardCharsets.UTF_8), new byte[] {(byte) 0xff}, new byte[65537])) {
            jdbc.update("UPDATE ma_resource SET inline_bytes=?,byte_length=?,sha256=? WHERE resource_id = X'666f726569676e2d696e707574'",
                    malformed, malformed.length, sha(malformed));
            assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("ma_resource")
                    && blocker.code().equals("invalid_historical_payload"));
        }
    }

    @Test
    void referencedReaderChecksJournalBytesAndReferencesWithTheirActualOwner() throws Exception {
        var expected = historicalKeys();
        byte[] records = ("{\"sessionId\":\"foreign-session\",\"payload\":{\"bindingId\":\"" + binding.getBindingId() + "\"}}\n")
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence,"
                + " event_count, writer_generation, writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                + " VALUES ('foreign', 'other-workspace', 'foreign-session', 1, ?, 'tx', 'operation', 'command', ?, 1, 1, 1, 1, 'writer', ?,"
                + " 1, 'identity', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")", "a".repeat(64), "b".repeat(64), "c".repeat(64), records, records.length, sha(records));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.table().equals("ma_session_journal_tx")
                && blocker.code().equals("extra_historical_reference"));
        byte[] harmless = "{\"sessionId\":\"foreign-session\",\"payload\":{\"text\":\"ordinary\"}}\n".getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?",
                harmless, harmless.length, sha(harmless));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest = ?", "0".repeat(64));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    @Test
    void referencedReaderCountsAllCandidateRowsAndRefusesOverLimitBeforeExpandingTheImage() throws Exception {
        var expected = historicalKeys();
        actionBatch("foreign", "new-session", WorkspaceCsiApplicationInventory.MAX_ROWS + 1);
        var result = readReferences(expected);
        assertThat(result.blockers()).anyMatch(blocker -> blocker.code().equals("row_limit"));
        assertThat(result.rowCount()).isEqualTo(WorkspaceCsiApplicationInventory.MAX_ROWS);
        assertThat(result.table("ma_session_record").rows()).isEmpty();
    }

    @Test
    void referencedReaderTreatsDeclaredRawOutputAsDataAndRejectsExternalStructuredPayloads() throws Exception {
        var expected = historicalKeys();
        var json = new ObjectMapper();
        var contract = json.readTree(java.nio.file.Path.of("../core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json").toFile())
                .path("cases").get(0).path("value");
        byte[] bindingBytes = json.writeValueAsBytes(contract);
        ToolPublicationContract.parseBytes("binding", bindingBytes);
        String scope = ToolPublicationDataStore.scope("tenant-1", "workspace-1", "session-1");
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id,"
                + " execution_key, capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes)"
                + " VALUES (?, ?, 'tenant-1', 'workspace-1', 'session-1', 'publication-1', ?, 'capture-1', ?, ?, ?, 'OPEN', 1024, 1024, 1024)",
                scope, ToolPublicationRetentionStore.hash("tenant-1"), sha(contract.path("executionCallId").textValue().getBytes(StandardCharsets.UTF_8)), new String(bindingBytes, StandardCharsets.UTF_8),
                ToolPublicationContract.bindingDigest(contract), "c".repeat(64));
        byte[] raw = ("{\"bindingId\":\"" + binding.getBindingId() + "\"}").getBytes(StandardCharsets.UTF_8);
        String contentId = "result-" + sha((scope + ":publication-1:content:output").getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        String resourceScope = ManagedSessionStore.sessionScopeKey("tenant-1", "session-1");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, scope_key,"
                + " publication_id, slot_key, resource_id, kind, schema_version, byte_length, sha256, inline_bytes, storage_kind, state, capture_state, operation_id, gmt_create)"
                + " VALUES (?, ?, 'tenant-1', 'workspace-1', 'session-1', ?, 'publication-1', 'content:output', ?, 'managed-tool-result-content',"
                + " 1, ?, ?, ?, 'MYSQL_INLINE', 'PUBLISHED', 'VERIFIED', 'publish', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(resourceScope, contentId), resourceScope, scope, contentId, raw.length, sha(raw), raw);
        assertThat(readReferences(expected).blockers()).isEmpty();
        assertThat(ToolPublicationContract.bindingDigest(contract)).isNotEqualTo(sha(bindingBytes));
        jdbc.update("UPDATE ma_output_capture SET binding_digest = ?", sha(bindingBytes));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
        jdbc.update("UPDATE ma_output_capture SET binding_digest = ?", ToolPublicationContract.bindingDigest(contract));
        jdbc.update("UPDATE ma_resource SET inline_bytes = NULL, storage_kind = 'TOOL_PUBLICATION', capture_object_key = ?",
                "managed-tool-results/" + scope + "/publication-1/" + sha("content:output".getBytes(StandardCharsets.UTF_8)));
        assertThat(readReferences(expected).blockers()).isEmpty();
        String terminalId = "result-" + sha((scope + ":publication-1:terminal").getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        jdbc.update("UPDATE ma_resource SET slot_key = 'terminal', kind = 'managed-tool-terminal', resource_id = ?, resource_key = ?, capture_object_key = ?",
                terminalId, ManagedSessionStore.resourceKey(resourceScope, terminalId),
                "managed-tool-results/" + scope + "/publication-1/" + sha("terminal".getBytes(StandardCharsets.UTF_8)));
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("unsupported_historical_payload"));
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, storage_kind = 'MYSQL_INLINE', capture_object_key = NULL", raw);
        assertThat(readReferences(expected).blockers()).anyMatch(blocker -> blocker.code().equals("invalid_historical_payload"));
    }

    @Test
    void referencedReaderFindsReadLeaseAliasesUsingVerifiedOriginalReadIds() throws Exception {
        String readId = UUID.randomUUID().toString();
        insertReadReceipt(readId, "RETURNED", "managed-root", 2, sha("{}".getBytes(StandardCharsets.UTF_8)),
                null, 2, 2L, "verified");
        var expected = historicalKeys();
        String unrelated = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_read_lease (lease_id, tenant_key, session_key, retirement_generation, expires_at)"
                + " VALUES (?, ?, ?, 0, 2)", unrelated, "b".repeat(64), "c".repeat(64));
        assertThat(readReferences(expected).blockers()).isEmpty();
        jdbc.update("UPDATE ma_read_lease SET lease_id = ? WHERE lease_id = ?", readId, unrelated);
        var found = readReferences(expected);
        assertThat(found.blockers()).anyMatch(blocker -> blocker.table().equals("ma_read_lease")
                && blocker.code().equals("extra_historical_reference"));
        assertThat(found.table("ma_read_lease").rows()).isEmpty();
    }

    @Test
    void nativeReceiptAliasesClosedJsonAndInitialDigestRemainMandatory() throws Exception {
        String id = UUID.randomUUID().toString();
        insertReadReceipt(id, "RETURNED", "managed-root", 2, sha("{}".getBytes(StandardCharsets.UTF_8)),
                null, 3, 2L, "verified");
        var original = jdbc.queryForMap("SELECT * FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'");
        assertThat(inspect().blockers()).noneMatch(blocker -> blocker.table().equals("ma_request_receipt")
                && blocker.code().equals("invalid_typed_association"));
        String body = (String) original.get("result_json");
        var unknown = new ObjectMapper().readTree(body).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) unknown).put("unexpected", "value");
        var coerced = new ObjectMapper().readTree(body).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) coerced).put("binding_version", "1");
        for (Object[] fault : List.of(
                new Object[]{"b".repeat(64), body, original.get("request_digest")},
                new Object[]{original.get("scope_key"), unknown.toString(), original.get("request_digest")},
                new Object[]{original.get("scope_key"), coerced.toString(), original.get("request_digest")},
                new Object[]{original.get("scope_key"), body, sha(body.getBytes(StandardCharsets.UTF_8))})) {
            jdbc.update("UPDATE ma_request_receipt SET scope_key = ?, result_json = ?, request_digest = ?"
                    + " WHERE receipt_key = ?", fault[0], fault[1], fault[2], original.get("receipt_key"));
            var refused = inspect();
            assertThat(refused.blockers()).anyMatch(blocker -> blocker.table().equals("ma_request_receipt")
                    && blocker.code().equals("invalid_typed_association"));
            assertThat(refused.blockers()).anyMatch(blocker -> blocker.table().equals("ma_request_receipt")
                    && blocker.code().equals("invalid_native_read_receipt"));
            assertThat(jdbc.queryForList("SELECT * FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ'")).hasSize(1);
        }
    }

    private void insertReadReceipt(String id, String state, String kind, long length, String contentDigest,
            String activation, long expires, Long ended, String outcome) {
        var value = new ObjectMapper().createObjectNode()
                .put("read_id", id).put("tenant_id", "tenant").put("workspace_id", "workspace").put("session_id", session)
                .put("request_key", binding.getRequest().requestKey()).put("binding_id", binding.getBindingId())
                .put("runtime_generation", binding.getGeneration()).put("binding_version", 1)
                .put("writer_id", "writer").put("writer_generation", 1).put("writer_token_hash", "a".repeat(64))
                .put("journal_revision", 1).put("activation_id", activation).put("activation_epoch", 1)
                .put("resource_id", "resource").put("kind", kind).put("schema_version", 1).put("byte_length", length)
                .put("sha256", contentDigest).put("storage_kind", "MYSQL_INLINE").put("resource_state", "REFERENCED")
                .put("started_at", 1).put("delivery_expires_at", expires);
        String requestDigest = sha(value.toString().getBytes(StandardCharsets.UTF_8));
        if (!"OPEN".equals(state)) {
            value.put("ended_at", ended).put("outcome_code", outcome);
        }
        jdbc.update("INSERT INTO ma_request_receipt (receipt_key,namespace,tenant_key,tenant_id,scope_kind,scope_key,scope_id,"
                        + "idempotency_key,idempotency_digest,request_digest,operation,state,session_id,result_json,gmt_create,gmt_modified)"
                        + " VALUES (?,'SESSION_COMMAND',?,'tenant','SESSION',?,?,?,?,?,'CSI_RESOURCE_READ',?,?,?,1,?)",
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", id),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("tenant"),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", "tenant", session), session,
                id, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(id), requestDigest,
                state, session, value.toString(), ended == null ? 1L : ended);
    }

    WorkspaceCsiApplicationInventory.Snapshot readReferences(WorkspaceCsiApplicationInventory.Snapshot expected) throws Exception {
        return readHistory(expected, new java.util.ArrayList<>(), true);
    }

    @Test
    void savedBaselineCannotHideOriginalEventsUsingCanonicalMembershipLabels() throws Exception {
        jdbc.update("UPDATE ma_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
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
                    var changed = relabel(baseline, "ma_public_event", label);
                    assertThat(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, changed))
                            .anyMatch(blocker -> blocker.table().equals("ma_public_event") && blocker.code().equals(
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
        jdbc.update("UPDATE ma_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var repository = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var claimed = repository.claimOperation(binding.getBindingId(), "resumed-coordinator", Duration.ofMinutes(1));
        assertThat(claimed.getVersion()).isGreaterThan(intent.sealedBindingVersion());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        try (var target = source.getConnection()) {
            target.setAutoCommit(false);
            try {
                var actual = JdbcCsiFilesRetirementGuard.lockBindingControl(target, binding.getBindingId());
                assertThat(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, baseline))
                        .noneMatch(blocker -> blocker.table().equals("ma_runtime_binding"));
            } finally {
                target.rollback();
            }
        }
    }

    @Test
    void savedBaselineDecodesEscapedSessionReferencesWithoutGlobalizingLocalResourceIds() throws Exception {
        jdbc.update("UPDATE ma_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var definition = baseline.table("ma_agent_definition");
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
                            "digest", "digest", "definition_json", json, "gmt_create", "1").entrySet()) {
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
        jdbc.update("UPDATE ma_runtime_binding SET first_activation_journal_revision = 2 WHERE binding_id = ?", binding.getBindingId());
        var baseline = WorkspaceCsiApplicationInventory.expectedImage(inspect().tables());
        var resource = baseline.table("ma_resource");
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
                            "resource_id", "local", "resource_key", ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey("foreign", "foreign-session"), "local"),
                            "kind", "managed-tool-input", "schema_version", "1", "byte_length", Integer.toString(bytes.length),
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

    WorkspaceCsiApplicationInventory.Snapshot historicalKeys() throws Exception {
        var sourceImage = inspect();
        var context = java.util.Set.of("ma_tenant_guard", "ma_workspace");
        var tables = sourceImage.tables().stream().map(table -> new WorkspaceCsiApplicationInventory.Table(
                table.name(), table.columns(), table.primaryKey(), table.rows().stream()
                        .filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL
                                || context.contains(table.name()) && row.membership() == WorkspaceCsiApplicationInventory.Membership.CONTEXT)
                        .map(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.CONTEXT
                                ? WorkspaceCsiApplicationHistoryImage.context(table.name(), row) : row).toList())).toList();
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private WorkspaceCsiApplicationInventory.Snapshot readKeys(WorkspaceCsiApplicationInventory.Snapshot expected,
            List<String> queries) throws Exception {
        return readHistory(expected, queries, false);
    }

    private WorkspaceCsiApplicationInventory.Snapshot readHistory(WorkspaceCsiApplicationInventory.Snapshot expected,
            List<String> queries, boolean references) throws Exception {
        try (var target = source.getConnection()) {
            target.setReadOnly(true);
            target.setAutoCommit(false);
            target.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            var observed = observedRead(target, queries);
            try {
                if (references) {
                    var saved = WorkspaceCsiApplicationImage.sole(expected, "ma_runtime_binding");
                    var original = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), binding.getGeneration(),
                            RuntimeBindingRecord.State.valueOf(saved.text("binding_state")), saved.bool("drain_requested"), saved.number("record_version"),
                            saved.number("first_activation_journal_revision"));
                    return WorkspaceCsiApplicationInventory.readRetainedReferencedKeys(
                            new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime()), expected, original, intent);
                }
                return WorkspaceCsiApplicationInventory.scanRetainedImage(
                        new WorkspaceCsiApplicationInventory.HistoricalScan(observed, System.nanoTime()), expected, Map.of());
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
        return ManagedSessionStore.sessionScopeKey("tenant", session);
    }

    private static String sha(byte[] bytes) {
        return org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes);
    }
}
