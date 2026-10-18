package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SshWorkspaceStoreTest {
    private JdbcTemplate jdbc;
    private SshWorkspaceStore store;

    @BeforeEach
    void setup() {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new SshWorkspaceStore(jdbc, new DataSourceTransactionManager(source));
    }

    javax.sql.DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:ssh-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @Test
    void registrationAtomicallyCreatesWorkspaceAndOwnerAndReplaysOriginalOperation() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        assertThat(intent).isNotNull();
        assertThat(store.claim("tenant", "actor", operation.operationId(), "other")).isNull();
        var registration = registration(intent);
        store.reserve(intent, "owner", registration);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
        assertThatThrownBy(() -> store.runtimeStorage("tenant", intent.storageId())).isInstanceOf(RuntimeException.class);
        store.complete(intent, "owner");
        var completed = store.get("tenant", "actor", operation.operationId());
        assertThat(completed.status()).isEqualTo("completed");
        assertThat(completed.workspaceId()).isEqualTo(intent.workspaceId());
        assertThat(store.begin("tenant", "actor", "key", "mac", "/work/project", "Project"))
                .isEqualTo(completed);
        assertThat(jdbc.queryForObject("SELECT role FROM ma_workspace_access", String.class)).isEqualTo("OWNER");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(store.verify(binding(intent))).isTrue();
        assertThat(WorkspaceExecutionStore.storageKey(jdbc, binding(intent)))
                .isEqualTo(SshWorkspaceStore.physicalKey(SshWorkspaceStore.object(registration, "identity")));
    }

    @Test
    void rejectsActorReplayPayloadChangesAndPhysicalAliases() {
        var first = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        assertThatThrownBy(() -> store.get("tenant", "other", first.operationId())).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> store.begin("tenant", "actor", "key", "mac", "/other", "Project"))
                .isInstanceOf(ApiException.class);
        var intent = store.claim("tenant", "actor", first.operationId(), "owner");
        store.reserve(intent, "owner", registration(intent));
        var second = store.begin("other-tenant", "actor", "another", "linux-alias", "/work/project", "Other");
        var alias = store.claim("other-tenant", "actor", second.operationId(), "second");
        assertThatThrownBy(() -> store.reserve(alias, "second", registration(alias)))
                .isInstanceOf(ApiException.class).hasMessageContaining("already has an owner");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void createsPromptedSshSessionsWithoutALocalMountAndKeepsAdmissionGates(boolean shell) {
        var operation = store.begin("tenant", "actor", "registration", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "registration");
        store.reserve(intent, "registration", registration(intent));
        store.complete(intent, "registration");
        var properties = sshProperties(shell);
        var ssh = properties.getRuntimeBroker().getSsh();
        var sessions = sessions(properties);
        var transaction = new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "Read the project"));
        var selection = new WorkspaceSelection(intent.workspaceId(), ".");
        var admitted = transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "create", "digest",
                "qwen-code", null, null, input, "payload", selection));
        assertThat(admitted.turnId()).isNotNull();
        assertThat(sessions.requireSession("tenant", admitted.sessionId()).toolProfile())
                .isEqualTo(shell ? WorkspaceToolProfiles.SHELL : WorkspaceToolProfiles.FILES);
        ssh.setEnabled(false);
        assertThat(transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "create", "digest",
                "qwen-code", null, null, input, "payload", selection)).sessionId()).isEqualTo(admitted.sessionId());
        assertThatThrownBy(() -> transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "another", "digest",
                "qwen-code", null, null, input, "payload", selection))).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isEqualTo(1);
        jdbc.update("UPDATE ma_turn SET status = 'COMPLETED' WHERE tenant_id = ? AND session_id = ?", "tenant", admitted.sessionId());
        assertThat(transaction.execute(ignored -> sessions.insertTurnCommand("tenant", "CREATE_TURN", "next-turn", "next-digest",
                admitted.sessionId(), input, "next-payload", "actor")).turnId()).isNotEqualTo(admitted.turnId());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void refusesUnsupportedRemoteProfilesWithoutChangingLocalDefinitionAdmission(boolean prompted) {
        var operation = store.begin("tenant", "actor", "registration", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "registration");
        store.reserve(intent, "registration", registration(intent));
        store.complete(intent, "registration");
        var properties = sshProperties(false);
        properties.setDefinitionToolProfiles(List.of(WorkspaceToolProfiles.MCP));
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "local", "/local")));
        var sessions = sessions(properties);
        var definitions = new ManagedAgentDefinitionStore(jdbc, new RequestDigests());
        sessions.setManagedAgentDefinitionStore(definitions);
        var transaction = new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        String agent = "agent_" + "a".repeat(32);
        transaction.executeWithoutResult(ignored -> definitions.create("tenant", "definition", "digest", agent, "d".repeat(64),
                "{\"tools\":[{\"type\":\"hosted_profile\",\"profile\":\"hosted-workspace-mcp/1\"}],"
                        + "\"mcp_servers\":[{\"server_id\":\"docs\",\"server_revision\":1,\"definition_digest\":\""
                        + "a".repeat(64) + "\"}]}", 1));
        var input = prompted ? List.<Map<String, Object>>of(Map.of("type", "text", "text", "Read")) : List.<Map<String, Object>>of();
        assertThatThrownBy(() -> transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "unsupported", "digest",
                agent, null, null, input, "payload", new WorkspaceSelection(intent.workspaceId(), ".")))).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Integer.class)).isZero();
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant', 'local', 1, 'local', 'Local', ?, ?, 'ACTIVE')", WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'local', ?, 'OWNER')",
                ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var local = transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "local", "digest",
                agent, null, null, input, "payload", new WorkspaceSelection("local", ".")));
        assertThat(sessions.requireSession("tenant", local.sessionId()).toolProfile()).isEqualTo(WorkspaceToolProfiles.MCP);
        var remote = transaction.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "remote", "digest",
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection(intent.workspaceId(), ".")));
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id = ? AND session_id = ?", WorkspaceToolProfiles.MCP, "tenant", remote.sessionId());
        assertThatThrownBy(() -> transaction.execute(ignored -> sessions.insertTurnCommand("tenant", "CREATE_TURN", "unsupported-turn", "digest",
                remote.sessionId(), List.of(Map.of("type", "text", "text", "Read")), "payload", "actor"))).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?", Integer.class, "tenant", remote.sessionId())).isZero();
    }

    private static ManagedAgentProperties sshProperties(boolean shell) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(shell);
        var ssh = properties.getRuntimeBroker().getSsh();
        ssh.setEnabled(true);
        ssh.setNodes(List.of(new SshRuntimeSettings.Node("mac", "Mac", "mac", "/node", "/qwen.js", "/state",
                List.of("/work"), 33222, "0.25.1", List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        return properties;
    }

    private ManagedAgentStore sessions(ManagedAgentProperties properties) {
        var registry = new ManagedWorkspaceRegistry(jdbc);
        registry.configureSsh(properties);
        return new ManagedAgentStore(jdbc, new com.fasterxml.jackson.databind.ObjectMapper(),
                Clock.systemUTC(), ignored -> {}, registry, properties);
    }

    @Test
    void retriesOnlyItsOriginalRegistrationAndFencesExpiredClaims() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "old");
        store.reserve(intent, "old", registration(intent));
        store.fail(intent, "old", "ssh_runtime_unavailable", true);
        var retry = store.claim("tenant", "actor", operation.operationId(), "new");
        assertThat(retry.registration()).isEqualTo(registration(intent));
        assertThatThrownBy(() -> store.complete(intent, "old")).isInstanceOf(ApiException.class);
        store.reserve(retry, "new", registration(intent));
        store.complete(retry, "new");
        jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE alias_key = ?", "fence",
                JdbcRuntimeBindingRepository.storageAliasKey("tenant", intent.storageId()));
        assertThatThrownBy(() -> store.verify(binding(intent))).isInstanceOf(RuntimeException.class);
    }

    @Test
    void aBlockedRegistrationCannotBeClaimedAndLocalGuardsRejectRemoteStorage() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        store.reserve(intent, "owner", registration(intent));
        store.fail(intent, "owner", "ssh_runtime_identity_mismatch", false);
        assertThat(store.get("tenant", "actor", operation.operationId()).status()).isEqualTo("recovery_blocked");
        assertThat(store.claim("tenant", "actor", operation.operationId(), "new")).isNull();
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireLocalAlias(jdbc, "tenant", intent.storageId()))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void independentRuntimeSessionsShareThePhysicalHolderAndStaleReleaseCannotClearItsSuccessor() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "registration");
        store.reserve(intent, "registration", registration(intent));
        store.complete(intent, "registration");
        var first = runtimeSession(intent, "first");
        var second = runtimeSession(intent, "second");
        var manager = new DataSourceTransactionManager(jdbc.getDataSource());
        var one = new WorkspaceExecutionStore(jdbc, manager);
        var two = new WorkspaceExecutionStore(jdbc, manager);
        var binding = binding(intent);
        one.claim(binding, first);
        assertThatThrownBy(() -> two.claim(binding, second))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        failure -> assertThat(failure.getCode()).isEqualTo("workspace_busy"));
        two.release(binding, second);
        one.assertHeld(binding, first);
        one.release(binding, first);
        two.claim(binding, second);
        one.release(binding, first);
        two.assertHeld(binding, second);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE holder_key IS NOT NULL", Integer.class))
                .isEqualTo(1);
    }

    private RuntimeSessionRecord runtimeSession(SshWorkspaceStore.Intent intent, String id) {
        var source = jdbc.getDataSource();
        var bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("test", new byte[32]));
        var scope = new RuntimeScope(intent.tenantId(), intent.workspaceId(), "1",
                "/work/project", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, id, "ssh-process", intent.storageId());
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "test", Duration.ofMinutes(5));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var now = Instant.now();
        var ready = bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle("ssh-process", 1, Map.of("fixture", true)), now, now));
        return bindings.admitSession(new JdbcRuntimeSessionRepository(source),
                new RuntimeSessionRecord(
                        new RuntimeSession(id, UUID.randomUUID().toString(), "bootstrap", scope),
                        ready.getBindingId(), ready.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, now));
    }

    // D7-2: register-storage runs after reserve, so an unreserved
    // registration never reached its node and its refusal is final.
    @Test
    void anUnreservedRegistrationFailsOutrightAndIsNeverParked() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        store.fail(intent, "owner", "ssh_runtime_version_mismatch", false);
        var failed = store.get("tenant", "actor", operation.operationId());
        assertThat(failed.status()).isEqualTo("failed");
        assertThat(failed.failureCode()).isEqualTo("ssh_runtime_version_mismatch");
        jdbc.update("UPDATE ma_operation SET available_at = 0");
        assertThat(store.findParked(10)).isEmpty();
        assertThat(store.claim("tenant", "actor", operation.operationId(), "new")).isNull();
    }

    // A reserved one may have reached its node: it parks for one delay, so
    // a register-storage still running when its caller gave up ends first.
    @Test
    void aReservedRegistrationParksForTheDelayThenReadsAsReserved() {
        var intent = parkedReservation();
        assertThat(jdbc.queryForObject("SELECT delivery_state FROM ma_operation", String.class)).isEqualTo("BLOCKED");
        assertThat(jdbc.queryForObject("SELECT available_at - " + com.alibaba.qwen.code.runtimebroker.managedschema
                .ManagedSchemaTime.SQL_NOW + " > 60000 FROM ma_operation", Boolean.class)).isTrue();
        assertThat(store.findParked(10)).isEmpty();
        jdbc.update("UPDATE ma_operation SET available_at = 0");
        assertThat(store.findParked(10)).containsExactly(new StoreModels.ParkedOperation("tenant", null,
                intent.operationId(), SshWorkspaceStore.OPERATION));
        var parked = store.parked("tenant", intent.operationId()).orElseThrow();
        assertThat(parked.reserved()).isTrue();
        assertThat(parked.failureCode()).isEqualTo("ssh_runtime_identity_mismatch");
        assertThat(parked.intent().registration()).isEqualTo(registration(intent));
        assertThat(store.reparkParked("tenant", intent.operationId(), 60_000)).isTrue();
        assertThat(store.findParked(10)).isEmpty();
    }

    // Committed evidence finishes the registration as the original attempt
    // would have, exactly once.
    @Test
    void aParkedRegistrationWhoseMarkerLandedCompletesOnce() {
        var intent = parkedReservation();
        assertThat(store.completeParked("tenant", intent.operationId())).isTrue();
        var completed = store.get("tenant", "actor", intent.operationId());
        assertThat(completed.status()).isEqualTo("completed");
        assertThat(completed.workspaceId()).isEqualTo(intent.workspaceId());
        assertThat(store.verify(binding(intent))).isTrue();
        assertThat(jdbc.queryForObject("SELECT role FROM ma_workspace_access", String.class)).isEqualTo("OWNER");
        assertThat(store.completeParked("tenant", intent.operationId())).isFalse();
        assertThat(store.releaseParked("tenant", intent.operationId(), "x")).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
    }

    // Evidence that the registration cannot land fails it and releases the
    // physical directory, so another registration can take it.
    @Test
    void aParkedRegistrationThatCannotLandFailsAndReleasesItsDirectory() {
        var intent = parkedReservation();
        assertThat(store.releaseParked("tenant", intent.operationId(), "ssh_runtime_identity_mismatch")).isTrue();
        var failed = store.get("tenant", "actor", intent.operationId());
        assertThat(failed.status()).isEqualTo("failed");
        assertThat(failed.failureCode()).isEqualTo("ssh_runtime_identity_mismatch");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isZero();
        assertThat(store.completeParked("tenant", intent.operationId())).isFalse();
        var next = store.begin("tenant", "actor", "key-2", "mac", "/work/project", "Project");
        var retry = store.claim("tenant", "actor", next.operationId(), "next");
        store.reserve(retry, "next", registration(retry));
        store.complete(retry, "next");
        assertThat(store.get("tenant", "actor", next.operationId()).status()).isEqualTo("completed");
    }

    // A release never takes what another registration finished: it deletes
    // only this registration's unfinished reservation.
    @Test
    void aReleaseLeavesAFinishedOwnerAlone() {
        var intent = parkedReservation();
        jdbc.update("UPDATE ma_storage SET registration_state = 'REGISTERED'");
        jdbc.update("UPDATE ma_storage_owner SET mount_state = 'READY'");
        assertThat(store.releaseParked("tenant", intent.operationId(), "x")).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    private SshWorkspaceStore.Intent parkedReservation() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        store.reserve(intent, "owner", registration(intent));
        store.fail(intent, "owner", "ssh_runtime_identity_mismatch", false);
        assertThat(store.get("tenant", "actor", operation.operationId()).status()).isEqualTo("recovery_blocked");
        return intent;
    }

    @Test
    void expiredOwnersCannotWriteFailureOrCompleteRegistration() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "expired");
        jdbc.update("UPDATE ma_operation SET claim_until = "
                + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW + " - 1000");
        store.fail(intent, "expired", "network_timeout", false);
        assertThat(store.get("tenant", "actor", operation.operationId()).status()).isEqualTo("running");
        assertThatThrownBy(() -> store.reserve(intent, "expired", registration(intent))).isInstanceOf(ApiException.class);
        assertThat(store.claim("tenant", "actor", operation.operationId(), "next")).isNotNull();
    }

    @Test
    void rejectsParentAndChildDirectoriesAcrossNodesTenantsAndLocalOwners() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "first");
        store.reserve(intent, "first", registration(intent));
        var nestedOperation = store.begin("another", "actor", "key", "alias", "/work/project/sub", "Sub");
        var nested = store.claim("another", "actor", nestedOperation.operationId(), "nested");
        assertThatThrownBy(() -> store.reserve(nested, "nested", registration(nested, "/work/project/sub", "3")))
                .hasMessageContaining("overlaps");
        assertThatThrownBy(() -> store.reserve(nested, "nested", registration(nested, "/work", "4")))
                .hasMessageContaining("overlaps");
        store.reserve(nested, "nested", registration(nested, "/work/project-other", "5"));
        jdbc.update("UPDATE ma_storage_owner SET storage_kind = 'LOCAL'");
        var localConflict = store.begin("third", "actor", "key", "alias", "/work/project/sub", "Sub");
        var candidate = store.claim("third", "actor", localConflict.operationId(), "third");
        assertThatThrownBy(() -> store.reserve(candidate, "third", registration(candidate, "/work/project/sub", "6")))
                .hasMessageContaining("overlaps");
    }

    @Test
    void concurrentParentAndChildReservationsHaveOnePhysicalWinner() throws Exception {
        var parent = store.begin("tenant", "actor", "parent", "mac", "/work/project", "Project");
        var child = store.begin("other", "actor", "child", "alias", "/work/project/sub", "Sub");
        var parentIntent = store.claim("tenant", "actor", parent.operationId(), "parent");
        var childIntent = store.claim("other", "actor", child.operationId(), "child");
        var start = new java.util.concurrent.CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> reserveAfter(start, parentIntent, "parent", registration(parentIntent)));
            var second = executor.submit(() -> reserveAfter(start, childIntent, "child",
                    registration(childIntent, "/work/project/sub", "3")));
            start.countDown();
            assertThat(java.util.List.of(first.get(), second.get())).containsExactlyInAnyOrder(true, false);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    private boolean reserveAfter(java.util.concurrent.CountDownLatch start, SshWorkspaceStore.Intent intent,
            String owner, Map<String, Object> registration) throws InterruptedException {
        start.await();
        try {
            store.reserve(intent, owner, registration);
            return true;
        } catch (RuntimeBrokerException conflict) {
            assertThat(conflict.getCode()).isEqualTo("storage_overlapping_roots");
            return false;
        }
    }

    private static ContextBinding binding(SshWorkspaceStore.Intent intent) {
        return new ContextBinding(intent.tenantId(), intent.workspaceId(), 1, intent.storageId(), ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
    }

    private static Map<String, Object> registration(SshWorkspaceStore.Intent intent) {
        return registration(intent, "/work/project", "2");
    }

    private static Map<String, Object> registration(SshWorkspaceStore.Intent intent, String root, String inode) {
        Map<String, Object> identity = Map.of("root", root, "hostId", "host", "device", "1",
                "inode", inode, "birthTime", "3");
        var marker = new LinkedHashMap<String, Object>(identity);
        marker.put("version", 2);
        marker.put("tenantId", intent.tenantId());
        marker.put("storageId", intent.storageId());
        marker.put("registrationId", intent.registrationId());
        return Map.of("nodeId", intent.nodeId(), "identity", identity, "marker", marker, "qwenVersion", "0.25.1");
    }
}
