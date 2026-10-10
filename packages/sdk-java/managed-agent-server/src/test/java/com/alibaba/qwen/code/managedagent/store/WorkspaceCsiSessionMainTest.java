package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceCsiSessionMainTest {
    private final ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private DriverManagerDataSource source;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private WorkspaceCsiRegistration registration;
    private ManagedAgentProperties properties;
    @TempDir Path temporary;

    @BeforeEach
    void setUp() {
        source = new DriverManagerDataSource("jdbc:h2:mem:csi-create-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        new WorkspaceCsiReservationStore(jdbc, manager, json).register(registration);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
    }

    @Test
    void createsAnOriginalPinBeforeAnyWorkerOrTurnAndReplaysWithoutChangingIt() {
        var physicalBefore = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        var first = create(request("create"));
        assertThat(first.replayed()).isFalse();
        assertThat(UUID.fromString(first.sessionId()).toString()).isEqualTo(first.sessionId());
        var row = jdbc.queryForMap("SELECT * FROM managed_agent_session");
        assertThat(row.get("tool_profile")).isEqualTo(CsiFilesRetirementProfile.PROFILE);
        assertThat(row.get("runtime_request_key")).isEqualTo(first.runtimeRequestKey());
        assertThat(row.get("workspace_generation")).isEqualTo(3L);
        assertThat(row.get("workspace_storage_id")).isEqualTo("storage");
        assertThat(row.get("context_config_ref")).isEqualTo(ManagedWorkspaceRegistry.descriptorRef(
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF));
        assertThat(row.get("creator_actor_key")).isEqualTo(ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        assertThat(row.get("owner_actor_key")).isEqualTo(row.get("creator_actor_key"));
        var sessions = store();
        var original = new TransactionTemplate(manager).execute(status -> sessions.requireCsiRequest(registration,
                first.sessionId()));
        assertThat(original.getIsolationKey()).isEqualTo(first.sessionId());
        assertThat(original.requestKey()).isEqualTo(first.runtimeRequestKey());
        assertThat(original.getScope().getCanonicalCwd()).isEqualTo("/workspace");
        properties.setAgentRevision("later-agent/2");
        jdbc.update("UPDATE managed_workspace_registry SET workspace_generation = 4, storage_id = 'changed',"
                + " config_ref = 'changed', policy_ref = 'changed'");
        var replay = create(request("create"));
        assertThat(replay).isEqualTo(new WorkspaceCsiSessionMain.Created(first.sessionId(), first.runtimeRequestKey(), true));
        assertThat(json.<com.fasterxml.jackson.databind.JsonNode>valueToTree(jdbc.queryForMap("SELECT * FROM managed_agent_session"))).isEqualTo(json.<com.fasterxml.jackson.databind.JsonNode>valueToTree(row));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(physicalBefore);
        assertEmpty("managed_agent_turn", "qwen_runtime_binding", "qwen_runtime_session", "qwen_tool_execution",
                "qwen_managed_session_journal_head");
        assertThat(count("managed_workspace_create_command")).isEqualTo(1);
        assertThat(count("managed_agent_consumer_progress")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT event_type FROM managed_agent_event", String.class)).isEqualTo("session.created");
    }

    @Test
    void privateCsiParentCannotCreateAnUnpinnedChildSession() {
        var original = create(request("parent"));
        var before = jdbc.queryForList("SELECT * FROM managed_agent_session");
        var commands = jdbc.queryForList("SELECT * FROM managed_workspace_create_command");
        var events = jdbc.queryForList("SELECT * FROM managed_agent_event");
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> store()
                .insertChildSessionCommand("tenant", original.sessionId(), "child", "digest", "child",
                        List.of(), null, new StoreModels.SessionLineage(original.sessionId(),
                                original.sessionId(), "child-run", 1))))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode())
                        .isEqualTo("child_parent_unavailable"));
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> store()
                .replayChildSessionCommand("tenant", original.sessionId(), "child", "digest")))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode())
                        .isEqualTo("child_parent_unavailable"));
        assertThat(jdbc.queryForList("SELECT * FROM managed_agent_session"))
                .usingRecursiveComparison().isEqualTo(before);
        assertThat(jdbc.queryForList("SELECT * FROM managed_workspace_create_command"))
                .usingRecursiveComparison().isEqualTo(commands);
        assertThat(jdbc.queryForList("SELECT * FROM managed_agent_event"))
                .usingRecursiveComparison().isEqualTo(events);
        assertEmpty("managed_agent_turn");
    }

    @Test
    void privateCsiParentIsRefusedBeforePublicChildAdmissionOrHarnessLookup() {
        var original = create(request("parent"));
        var childStore = mock(AgentStateStore.class);
        var harness = mock(HarnessConnector.class);
        when(childStore.requireSession("tenant", original.sessionId()))
                .thenReturn(store().requireSession("tenant", original.sessionId()));
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(childStore.insertChildSessionCommand(anyString(),
                anyString(), anyString(),
                anyString(), anyString(),
                anyList(), anyString(),
                any()))
                .thenReturn(new StoreModels.Admission("child", null, false, false));
        var service = new ManagedAgentService(childStore,
                new RequestDigests(),
                mock(HarnessCoordinator.class),
                harness, new ManagedWorkspaceRegistry(jdbc));
        assertThatThrownBy(() -> service.createChildSession("tenant", original.sessionId(), "child-run",
                "audit", "inspect"))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode())
                        .isEqualTo("child_parent_unavailable"));
        verify(harness, never()).isWorkspaceFilesAvailable();
        verify(childStore, never())
                .insertChildSessionCommand(anyString(), anyString(),
                        anyString(), anyString(),
                        anyString(), anyList(),
                        anyString(), any());
    }

    @Test
    void concurrentCreatorsCommitOneOriginalSession() throws Exception {
        var gate = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var one = executor.submit(() -> { gate.await(); return create(request("race")); });
            var two = executor.submit(() -> { gate.await(); return create(request("race")); });
            var first = one.get(10, TimeUnit.SECONDS);
            var second = two.get(10, TimeUnit.SECONDS);
            assertThat(first.sessionId()).isEqualTo(second.sessionId());
            assertThat(first.runtimeRequestKey()).isEqualTo(second.runtimeRequestKey());
            assertThat(first.replayed()).isNotEqualTo(second.replayed());
        }
        assertThat(count("managed_agent_session")).isEqualTo(1);
        assertThat(count("managed_workspace_create_command")).isEqualTo(1);
        assertThat(count("managed_agent_event")).isEqualTo(1);
    }

    @Test
    void differentIdempotencyKeysProduceDifferentSessionAuthority() {
        assertThat(create(request("first")).runtimeRequestKey()).isNotEqualTo(create(request("second")).runtimeRequestKey());
        assertThat(count("managed_agent_session")).isEqualTo(2);
    }

    @Test
    void refusesRegistrationStoragePolicyPermissionAndRevisionChangesWithoutPartialCreate() {
        String[] changes = {"UPDATE managed_workspace_registry SET storage_id = 'other'",
                "UPDATE managed_workspace_registry SET config_ref = 'legacy'",
                "UPDATE managed_workspace_registry SET policy_ref = 'other'",
                "UPDATE managed_workspace_registry SET state = 'DRAINING'",
                "UPDATE managed_workspace_access SET role = 'READER'",
                "UPDATE managed_workspace_access SET actor_id = X'6f74686572'",
                "UPDATE managed_workspace_csi_registration SET registration_revision = 8"};
        for (String change : changes) {
            jdbc.update(change);
            if (change.contains("managed_workspace_csi_registration")) {
                assertThatThrownBy(() -> create(request("rejected"))).isInstanceOf(RuntimeBrokerException.class)
                        .hasMessage("Workspace CSI admission is unavailable.");
            } else {
                assertThatThrownBy(() -> create(request("rejected"))).isInstanceOf(ApiException.class)
                        .satisfies(error -> assertThat(((ApiException) error).getCode())
                                .isIn("workspace_unavailable", "workspace_not_found", "workspace_forbidden"));
            }
            assertEmpty("managed_agent_session", "managed_workspace_create_command", "managed_agent_event",
                    "managed_agent_consumer_progress", "managed_session_create_scope");
            jdbc.update("UPDATE managed_workspace_registry SET storage_id = 'storage', config_ref = ?, policy_ref = ?,"
                    + " state = 'ACTIVE'", CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update("UPDATE managed_workspace_access SET role = 'OPERATOR', actor_id = ?",
                    ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            jdbc.update("UPDATE managed_workspace_csi_registration SET registration_revision = 7");
        }
        var wrongRevision = new WorkspaceCsiSessionMain.Request(registration, "actor", "rejected", "unsupported", null,
                new WorkspaceSelection("workspace", "."));
        assertThatThrownBy(() -> create(wrongRevision)).isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode()).isEqualTo("unsupported_feature"));
        assertEmpty("managed_agent_session", "managed_session_create_scope");
    }

    @Test
    void refusesChangedRequestAndCorruptedPinOnReplay() {
        var first = create(request("replay"));
        var before = jdbc.queryForMap("SELECT * FROM managed_agent_session");
        var changed = new WorkspaceCsiSessionMain.Request(registration, "actor", "replay", null, "different",
                new WorkspaceSelection("workspace", "."));
        assertThatThrownBy(() -> create(changed)).isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode()).isEqualTo("idempotency_conflict"));
        assertThat(json.<com.fasterxml.jackson.databind.JsonNode>valueToTree(jdbc.queryForMap("SELECT * FROM managed_agent_session"))).isEqualTo(json.<com.fasterxml.jackson.databind.JsonNode>valueToTree(before));
        jdbc.update("UPDATE managed_agent_session SET runtime_request_key = ?", "a".repeat(64));
        assertThatThrownBy(() -> create(request("replay"))).isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode()).isEqualTo("workspace_unavailable"));
        assertThat(count("managed_agent_session")).isEqualTo(1);
        assertThat(count("managed_agent_event")).isEqualTo(1);
        assertThat(first.sessionId()).isEqualTo(jdbc.queryForObject("SELECT session_id FROM managed_agent_session", String.class));
    }

    @Test
    void failedInsertRollsBackTheCompleteCreationCommand() {
        jdbc.execute("ALTER TABLE managed_agent_session ADD CONSTRAINT refuse_test_create CHECK (title <> 'reject')");
        var refused = new WorkspaceCsiSessionMain.Request(registration, "actor", "reject", null, "reject",
                new WorkspaceSelection("workspace", "."));
        assertThatThrownBy(() -> create(refused)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertEmpty("managed_agent_session", "managed_session_create_scope", "managed_workspace_create_command",
                "managed_agent_event", "managed_agent_consumer_progress");
    }

    @Test
    void cannotJoinAnUnboundCommandOrCallerTransaction() {
        new TransactionTemplate(manager).executeWithoutResult(status -> store().insertSessionCommand("tenant", "actor",
                "CREATE_SESSION", "unbound", "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null));
        assertThatThrownBy(() -> create(request("unbound"))).isInstanceOf(ApiException.class)
                .satisfies(error -> assertThat(((ApiException) error).getCode()).isEqualTo("idempotency_conflict"));
        assertThat(count("managed_agent_session")).isEqualTo(1);
        new TransactionTemplate(manager).executeWithoutResult(status -> assertThatThrownBy(() -> create(request("new")))
                .isInstanceOf(IllegalStateException.class).hasMessage("Private CSI CREATE requires a fresh transaction"));
    }

    @Test
    void oldWorkspaceCreationDoesNotAcquireTheNewProfileOrRequestPin() {
        var legacy = new TransactionTemplate(manager).execute(status -> store().insertWorkspaceSessionCommand("tenant",
                "actor", "old", "sha256:" + "b".repeat(64), "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("workspace", ".")));
        assertThat(legacy).isNotNull();
        assertThat(jdbc.queryForObject("SELECT tool_profile FROM managed_agent_session", String.class))
                .isEqualTo("hosted-workspace-files/1");
        assertThat(jdbc.queryForObject("SELECT runtime_request_key FROM managed_agent_session", String.class)).isNull();
    }

    @Test
    void cannotBorrowAnotherDatasourceTransaction() {
        var other = new DriverManagerDataSource("jdbc:h2:mem:csi-other-" + UUID.randomUUID(), "sa", "");
        assertThatThrownBy(() -> WorkspaceCsiSessionMain.create(jdbc, new DataSourceTransactionManager(other),
                json, properties, request("other-transaction"))).isInstanceOf(IllegalStateException.class)
                .hasMessage("Private CSI CREATE requires its original transaction connection");
        assertEmpty("managed_agent_session", "managed_workspace_create_command", "managed_agent_event");
    }

    @Test
    void refusesSubdirectoriesBeforeCreation() throws Exception {
        String encoded = json.writeValueAsString(request("subdirectory"));
        Path path = temporary.resolve("subdirectory.json");
        Files.writeString(path, encoded.replace("\"cwdRelative\":\".\"", "\"cwdRelative\":\"subdir\""));
        assertThatThrownBy(() -> WorkspaceCsiSessionMain.readRequest(path, json))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("CSI Session request could not be read");
        assertEmpty("managed_agent_session", "managed_workspace_create_command", "managed_agent_event",
                "managed_agent_consumer_progress", "managed_session_create_scope");
    }

    @Test
    void strictInputReaderRejectsAddedFieldsDuplicateKeysTrailingTokensAndSizeOverflow() throws Exception {
        String encoded = json.writeValueAsString(request("reader"));
        Path path = temporary.resolve("reviewed.json");
        Files.writeString(path, encoded);
        assertThat(WorkspaceCsiSessionMain.readRequest(path, json)).isEqualTo(request("reader"));
        for (String invalid : new String[] {encoded.substring(0, encoded.length() - 1) + ",\"input\":[]}",
                "{\"actorId\":\"other\"," + encoded.substring(1), encoded + " {}", "null", " ".repeat(32 * 1024 + 1)}) {
            Files.writeString(path, invalid);
            assertThatThrownBy(() -> WorkspaceCsiSessionMain.readRequest(path, json))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage("CSI Session request could not be read");
        }
        assertEmpty("managed_agent_session");
    }

    @TestFactory
    Stream<DynamicTest> refusesEveryLegacyMutationWithoutChangingAnyPersistedTable() {
        var original = create(request("legacy-boundary"));
        // A leftover legacy operation is an unsupported fact, not CSI retirement authority.
        insertLegacyOperation(original.sessionId());
        var before = allTables();
        var names = List.of("insertTurnCommand", "insertCancelCommand", "beginSessionMutation",
                "completeSessionMutation", "abandonSessionMutation", "beginOperation", "beginWorkspaceClose",
                "beginWorkspaceLifecycle", "unarchiveWorkspaceSession", "beginCwdChangeOperation",
                "completeCwdChangeOperation", "failCwdChangeOperation", "claimOperation", "completeOperation",
                "renewLifecycleOperation", "blockLifecycleOperation", "retryOperation", "advanceReplayFloor",
                "materializeNextBatch", "claimTurn", "renewTurn", "releaseTurnLease", "scheduleTurnRetry",
                "bindHarness", "bindRecoveredHarness", "markSubmissionAttempted", "withdrawSubmissionAttempted",
                "recordAdmission", "recordRecoveryAdmission", "retractContinuationOutput", "retractHarnessTurnOutput",
                "recordHarnessEvents", "cancelBeforeAdmission", "failTurn", "appendPublicEventIfAbsent",
                "appendLiveSessionEventIfAbsent");
        assertThat(Arrays.stream(ManagedAgentStore.class.getMethods()).map(Method::getName).distinct()
                .filter(names::contains).sorted().toList())
                .containsExactlyElementsOf(names.stream().sorted().toList());
        return Arrays.stream(ManagedAgentStore.class.getMethods()).filter(method -> names.contains(method.getName()))
                .map(method -> DynamicTest.dynamicTest(method.toString(), () -> {
                    assertPrivateRefusal(() -> new TransactionTemplate(manager).executeWithoutResult(status ->
                            invokeMutation(method, original.sessionId())));
                    assertThat(allTables()).isEqualTo(before);
                }));
    }

    @Test
    void retainedRequestPinStillRefusesAfterAConflictingProfileChange() {
        var original = create(request("retained-pin"));
        jdbc.update("UPDATE managed_agent_session SET tool_profile = 'hosted-workspace-files/1'");
        assertThat(jdbc.queryForObject("SELECT csi_guard FROM managed_agent_session", Boolean.class)).isTrue();
        var before = allTables();
        assertPrivateRefusal(() -> new TransactionTemplate(manager).executeWithoutResult(status ->
                store().appendPublicEventIfAbsent("tenant", original.sessionId(), null, "session.environment",
                        Map.of(), false, "late-warmup")));
        assertPrivateRefusal(() -> new TransactionTemplate(manager).executeWithoutResult(status -> store()
                .insertChildSessionCommand("tenant", original.sessionId(), "child", "digest", "child",
                        List.of(), null, new StoreModels.SessionLineage(original.sessionId(),
                                original.sessionId(), "child-run", 1))));
        assertThat(allTables()).isEqualTo(before);
    }

    @Test
    void privateBacklogDoesNotStarveOrdinaryProjectionDispatchOrOperationWork() {
        for (int index = 0; index < 3; index++) {
            var original = create(request("backlog-" + index));
            insertLegacyOperation(original.sessionId());
            jdbc.update("INSERT INTO managed_agent_snapshot (tenant_id, session_id, snapshot_version,"
                    + " covered_sequence, items_json, created_at, updated_at) VALUES ('tenant', ?, 1, 1, '[]', 0, 0)",
                    original.sessionId());
        }
        var tx = new TransactionTemplate(manager);
        var ordinary = tx.execute(status -> store().insertSessionCommand("tenant", "actor", "CREATE_SESSION",
                "ordinary-turn", "digest", "qwen-code", null, null,
                List.of(Map.of("type", "text", "text", "hello")), "payload"));
        var idle = tx.execute(status -> store().insertSessionCommand("tenant", "actor", "CREATE_SESSION",
                "ordinary-operation", "other-digest", "qwen-code", null, null, List.of(), null));
        var operation = tx.execute(status -> store().beginOperation("tenant", idle.sessionId(),
                StoreModels.OperationKind.CLOSE, "", "close", "close-digest"));
        assertThat(store().findMaterializationTargets(1)).extracting(StoreModels.MaterializationTarget::sessionId)
                .containsExactly(ordinary.sessionId());
        assertThat(tx.execute(status -> store().materializeNextBatch("tenant", ordinary.sessionId(), 100)).advanced())
                .isTrue();
        assertThat(store().findReplayFloorTargets(1)).extracting(StoreModels.ReplayFloorTarget::sessionId)
                .containsExactly(ordinary.sessionId());
        assertThat(tx.execute(status -> store().advanceReplayFloor("tenant", ordinary.sessionId(), 100)).floorSequence())
                .isGreaterThan(0);
        var ordinaryTurn = jdbc.queryForMap("SELECT * FROM managed_agent_turn WHERE session_id = ?", ordinary.sessionId());
        var privateTurn = new java.util.LinkedHashMap<>(ordinaryTurn);
        privateTurn.put("session_id", jdbc.queryForObject("SELECT session_id FROM managed_agent_session"
                + " WHERE csi_guard = TRUE ORDER BY session_id LIMIT 1", String.class));
        privateTurn.put("turn_id", "private-legacy-turn");
        privateTurn.put("prompt_id", UUID.randomUUID().toString());
        privateTurn.put("updated_at", 0L);
        jdbc.update("INSERT INTO managed_agent_turn (" + String.join(",", privateTurn.keySet()) + ") VALUES ("
                + String.join(",", java.util.Collections.nCopies(privateTurn.size(), "?")) + ")",
                privateTurn.values().toArray());
        assertThat(store().findDispatchable(System.currentTimeMillis(), 1))
                .extracting(StoreModels.DispatchTarget::sessionId).containsExactly(ordinary.sessionId());
        assertThat(store().findDeliverableOperations(0, 1)).extracting(StoreModels.OperationTarget::sessionId)
                .containsExactly(idle.sessionId());
        var claimedOperation = tx.execute(status -> store().claimOperation("tenant", idle.sessionId(),
                operation.operation().operationId(), "owner", Duration.ofMinutes(1)));
        assertThat(claimedOperation).isPresent();
        var claimedTurn = tx.execute(status -> store().claimTurn("tenant", ordinary.sessionId(), ordinary.turnId(),
                "owner", Duration.ofMinutes(1)));
        assertThat(claimedTurn).isPresent();
        var renewedTurn = tx.execute(status -> store().renewTurn("tenant", ordinary.sessionId(), ordinary.turnId(),
                "owner", Duration.ofMinutes(1)));
        assertThat(renewedTurn).isTrue();
        tx.executeWithoutResult(status -> store().scheduleTurnRetry("tenant", ordinary.sessionId(),
                ordinary.turnId(), "owner", 0));
        assertThat(store().findTurn("tenant", ordinary.sessionId(), ordinary.turnId()).orElseThrow().dispatchOwner())
                .isNull();
        var reclaimedTurn = tx.execute(status -> store().claimTurn("tenant", ordinary.sessionId(), ordinary.turnId(),
                "owner", Duration.ofMinutes(1)));
        assertThat(reclaimedTurn).isPresent();
        tx.executeWithoutResult(status -> store().releaseTurnLease("tenant", ordinary.sessionId(),
                ordinary.turnId(), "owner"));
        assertThat(store().findTurn("tenant", ordinary.sessionId(), ordinary.turnId()).orElseThrow().dispatchOwner())
                .isNull();
    }

    private void invokeMutation(Method method, String sessionId) {
        Object[] arguments = Arrays.stream(method.getParameterTypes()).map(type -> {
            if (type == String.class) {
                return (Object) "unused";
            }
            if (type == long.class) {
                return 1L;
            }
            if (type == int.class) {
                return 1;
            }
            if (type == boolean.class) {
                return true;
            }
            if (type == Duration.class) {
                return Duration.ofMinutes(1);
            }
            if (type.isEnum()) {
                return type.getEnumConstants()[0];
            }
            if (type == List.class) {
                return List.of();
            }
            if (type == Map.class) {
                return Map.of();
            }
            throw new IllegalStateException("Unsupported mutation parameter " + type);
        }).toArray();
        arguments[0] = "tenant";
        int sessionIndex = switch (method.getName()) {
            case "insertTurnCommand", "insertCancelCommand", "beginSessionMutation" -> 4;
            case "completeSessionMutation", "abandonSessionMutation" -> 3;
            default -> 1;
        };
        arguments[sessionIndex] = sessionId;
        try {
            method.invoke(store(), arguments);
        } catch (InvocationTargetException error) {
            if (error.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new IllegalStateException(error.getCause());
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }

    private void insertLegacyOperation(String session) {
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id, operation_kind,"
                + " actor_digest, idempotency_key, request_digest, state, admission_stage, delivery_state,"
                + " session_status_before, available_at, created_at, updated_at) VALUES"
                + " ('tenant', ?, ?, 'CLOSE', '', 'unused', 'digest', 'PENDING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0, 0)",
                session, count("managed_agent_operation") == 0 ? "unused" : UUID.randomUUID().toString());
    }

    private Map<String, JsonNode> allTables() {
        var result = new TreeMap<String, JsonNode>();
        for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                + " WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
            var rows = jdbc.queryForList("SELECT * FROM " + table).stream().map(row -> {
                row.replaceAll((column, value) -> {
                    if (value instanceof java.sql.Clob clob) {
                        try {
                            return clob.getSubString(1, Math.toIntExact(clob.length()));
                        } catch (java.sql.SQLException error) {
                            throw new IllegalStateException(error);
                        }
                    }
                    return value;
                });
                return json.<JsonNode>valueToTree(row);
            })
                    .sorted(Comparator.comparing(JsonNode::toString)).toList();
            result.put(table, json.valueToTree(rows));
        }
        assertThat(result).hasSize(62);
        return result;
    }

    private static void assertPrivateRefusal(org.assertj.core.api.ThrowableAssert.ThrowingCallable operation) {
        assertThatThrownBy(operation).isInstanceOf(ApiException.class).satisfies(error -> {
            var refusal = (ApiException) error;
            assertThat(refusal.getCode()).isEqualTo("csi_managed_mutation_unavailable");
            assertThat(refusal.getStatus()).isEqualTo(org.springframework.http.HttpStatus.CONFLICT);
        });
    }

    private WorkspaceCsiSessionMain.Request request(String idempotencyKey) {
        return new WorkspaceCsiSessionMain.Request(registration, "actor", idempotencyKey, null, null,
                new WorkspaceSelection("workspace", "."));
    }

    private WorkspaceCsiSessionMain.Created create(WorkspaceCsiSessionMain.Request request) {
        return WorkspaceCsiSessionMain.create(jdbc, manager, json, properties, request);
    }

    private ManagedAgentStore store() {
        return new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
    }

    private void assertEmpty(String... tables) {
        for (String table : tables) {
            assertThat(count(table)).as(table).isZero();
        }
    }

    private int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class);
    }
}
