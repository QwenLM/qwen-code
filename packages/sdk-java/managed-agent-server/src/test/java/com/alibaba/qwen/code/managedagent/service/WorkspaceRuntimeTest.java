package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceOperatorRecoveryStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import java.time.Duration;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import com.fasterxml.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-execution;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class WorkspaceRuntimeTest {
    @Autowired
    private ManagedAgentStore sessions;
    @Autowired
    private WorkspaceExecutionStore authority;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private DataSource dataSource;
    @TempDir
    private Path temp;

    @Test
    void operatorRecoveryFencesTheExactHeldGenerationBeforeAttestation() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var scope = resolver(session, temp.toRealPath()).resolve(session.sessionId()).scope();
        var bindings = bindings();
        var request = new RuntimeProvisionRequest(scope, session.sessionId(),
                "local-process", session.workspace().getStorageId());
        RuntimeBindingRecord runtime = readyBinding(bindings, request, 2);
        String runtimeSessionId = UUID.randomUUID().toString();
        RuntimeSessionRecord held = bindings.admitSession(new JdbcRuntimeSessionRepository(dataSource),
                new RuntimeSessionRecord(new RuntimeSession(session.sessionId(), runtimeSessionId,
                        "bootstrap", scope), runtime.getBindingId(), runtime.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        authority.claim(session.workspace(), held);
        String callId = UUID.randomUUID().toString();
        Map<String, Object> reference = Map.of("sessionId", runtimeSessionId,
                "promptId", "prompt", "callId", "call", "argsDigest", "digest",
                "runtimeProtocol", 3, "inputDigest", "digest", "dispatchMode", "deferred");
        var executions = new JdbcToolExecutionRepository(dataSource);
        ToolExecutionRecord prepared = executions.findOrCreate(ToolExecutionRecord.prepared(callId,
                UUID.randomUUID().toString(), runtime.getBindingId(), runtime.getGeneration(),
                session.sessionId(), runtimeSessionId, "prompt", "call", "digest", reference));
        ToolExecutionRecord dispatched = executions.claimDispatch(callId, "dispatcher", Duration.ofMinutes(1));
        assertThat(dispatched).isNotNull();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", "success");
        result.put("responseParts", List.of());
        result.put("capture", Map.of("captureStatus", "partial",
                "captureReason", "producer_lost"));
        assertThat(executions.compareAndSet(dispatched,
                dispatched.withResult(result, 1, Instant.now()), "dispatcher",
                dispatched.getDispatchGeneration())).isNotNull();
        var seed = runtime.getProvisionSeed();
        var handle = runtime.getResourceHandle();
        RuntimeRecoveryEvidence originalLoss = new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                RuntimeRecoveryEvidence.Fact.JOURNAL_LOST, "registered-process-exit", Instant.now(),
                "host", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), handle);
        assertThat(bindings.compareAndSet(runtime,
                runtime.withRecoveryEvidence(originalLoss, null, Instant.now()))).isNotNull();

        var recovery = new WorkspaceOperatorRecoveryStore(jdbc,
                new DataSourceTransactionManager(dataSource), bindings, new ObjectMapper());
        var inspection = recovery.inspect(runtime.getBindingId(), runtime.getGeneration());
        assertThat(inspection.captureReason()).isEqualTo("producer_lost");
        assertThat(inspection.executionCallId()).isEqualTo(callId);
        assertThat(inspection.eligibleForPrepare()).isTrue();
        assertThatThrownBy(() -> recovery.prepare(runtime.getBindingId(), runtime.getGeneration(),
                "0".repeat(64), "operator", "verified incident"))
                .isInstanceOf(IllegalStateException.class);
        String recoveryId = recovery.prepare(runtime.getBindingId(), runtime.getGeneration(),
                inspection.holderKey(), "operator", "verified incident");
        assertThat(bindings.findById(runtime.getBindingId()).getState())
                .isEqualTo(RuntimeBindingRecord.State.LOST);
        assertThat(bindings.findById(runtime.getBindingId()).getLossEvidence())
                .isEqualTo(originalLoss);
        assertThat(bindings.findRecoveryCandidates("local-process", null, 100))
                .noneMatch(candidate -> candidate.getBindingId().equals(runtime.getBindingId()));
        assertThat(recovery.inspect(runtime.getBindingId(), runtime.getGeneration())
                .eligibleForPrepare()).isFalse();
        assertThat(recovery.prepare(runtime.getBindingId(), runtime.getGeneration(),
                inspection.holderKey(), "operator", "verified incident")).isEqualTo(recoveryId);
        assertThatThrownBy(() -> recovery.prepare(runtime.getBindingId(), runtime.getGeneration(),
                inspection.holderKey(), "other-operator", "verified incident"))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> recovery.prepare(runtime.getBindingId(), runtime.getGeneration(),
                inspection.holderKey(), "operator", "changed reason"))
                .isInstanceOf(IllegalStateException.class);
        assertUnavailable(() -> authority.release(session.workspace(), held));
        assertThatThrownBy(() -> bindings.findOrCreate(new RuntimeProvisionRequest(
                scope, "other-session", "local-process", session.workspace().getStorageId())))
                .isInstanceOf(RuntimeBrokerException.class);
        RuntimeScope changedWorkspace = new RuntimeScope(scope.getTenantId(), "renamed-workspace",
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass());
        assertThatThrownBy(() -> bindings.findOrCreate(new RuntimeProvisionRequest(
                changedWorkspace, "other-session", "local-process", session.workspace().getStorageId())))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> bindings.findOrCreate(new RuntimeProvisionRequest(
                changedWorkspace, "other-session", "local-process", "renamed-storage")))
                .isInstanceOf(RuntimeBrokerException.class);
        authority.assertHeld(session.workspace(), held);
        var operation = recovery.operation(recoveryId);
        recovery.requireSnapshot(operation, bindings.findById(runtime.getBindingId()));
        String handleJson = jdbc.queryForObject("SELECT resource_handle_json"
                + " FROM managed_workspace_operator_recovery WHERE recovery_id = ?",
                String.class, recoveryId);
        jdbc.update("UPDATE managed_workspace_operator_recovery SET resource_handle_json = '{}'"
                + " WHERE recovery_id = ?", recoveryId);
        assertThatThrownBy(() -> recovery.requireSnapshot(operation,
                bindings.findById(runtime.getBindingId()))).isInstanceOf(IllegalStateException.class);
        jdbc.update("UPDATE managed_workspace_operator_recovery SET resource_handle_json = ?"
                + " WHERE recovery_id = ?", handleJson, recoveryId);
        byte[] evidence = "verified stopped writers".getBytes(StandardCharsets.UTF_8);
        recovery.attest(operation, evidence);
        recovery.attest(operation, evidence);
        assertThatThrownBy(() -> recovery.attest(operation,
                "changed proof".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalStateException.class);
        authority.assertHeld(session.workspace(), held);

        RuntimeBindingRecord fenced = bindings.claimOperation(runtime.getBindingId(),
                "operator-test", Duration.ofSeconds(10));
        assertThat(fenced).isNotNull();
        RuntimeRecoveryEvidence stop = new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED, "operator-attested:" + recoveryId,
                Instant.now(), "host", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), handle);
        assertThat(bindings.compareAndSet(fenced,
                fenced.withRecoveryEvidence(originalLoss, stop, Instant.now()))).isNotNull();
        RuntimeProvisioner local = mock(RuntimeProvisioner.class);
        when(local.kind()).thenReturn("local-process");
        when(local.supportsStartupRecovery(any())).thenReturn(true);
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?",
                session.tenantId());
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 2"
                + " WHERE session_id = ?", session.sessionId());
        try (var broker = new RuntimeBrokerService(
                ignored -> CompletableFuture.failedFuture(new AssertionError("authorization was consulted")),
                new WorkspaceRuntimeProvisioner(local, null, authority), new HttpRuntimeTransport(),
                bindings, new JdbcRuntimeSessionRepository(dataSource), executions,
                "operator-test", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            RuntimeBindingRecord released = broker.recoverBinding(runtime.getBindingId(), runtime.getGeneration())
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertThat(released.getState()).isEqualTo(RuntimeBindingRecord.State.RELEASED);
            assertThat(released.getStopEvidence().source()).isEqualTo("operator-attested:" + recoveryId);
        }
        recovery.complete(operation);
        assertThat(recovery.operation(recoveryId).completed()).isTrue();
        recovery.attest(operation, evidence);
        assertThatThrownBy(() -> recovery.attest(operation,
                "changed proof".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalStateException.class);
        assertThat(executions.findByExecutionCallId(callId).getState())
                .isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease"
                + " WHERE binding_id = ?", Long.class, runtime.getBindingId())).isZero();
        jdbc.update("UPDATE managed_workspace_access SET can_read = TRUE WHERE tenant_id = ?",
                session.tenantId());
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE', deleted_at = NULL"
                + " WHERE session_id = ?", session.sessionId());
        RuntimeSessionRecord next = holder(session, "next");
        authority.claim(session.workspace(), next);
        authority.assertHeld(session.workspace(), next);
    }

    @Test
    void resolvesSavedWorkspaceAndFrozenReferencesDespiteDefaultAndRegistryConfigChanges() throws Exception {
        SessionRecord session = createSession("storage", "child");
        Path root = Files.createDirectory(temp.resolve("root")).toRealPath();
        var resolver = resolver(session, root);
        var resolved = resolver.resolve(session.sessionId());
        assertThat(resolved.scope().getCanonicalCwd()).isEqualTo(root.toString());
        assertThat(resolved.binding().getCwdRelative()).isEqualTo("child");
        assertThat(resolved.scope().getWorkspaceId()).isEqualTo("workspace");
        assertThat(resolved.scope().getCapabilityDigest()).isEqualTo(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
        jdbc.update("UPDATE managed_workspace_registry SET config_ref = 'later', policy_ref = 'later' WHERE tenant_id = ?",
                session.tenantId());
        assertThat(resolver.resolve(session.sessionId())).isEqualTo(resolved);
        jdbc.update("UPDATE managed_workspace_registry SET workspace_generation = 2 WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
        jdbc.update("UPDATE managed_workspace_registry SET workspace_generation = 1, storage_id = 'other' WHERE tenant_id = ?",
                session.tenantId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
    }

    @Test
    void refusesRevokedGrantsDeletedSessionsAndUnknownFrozenProfiles() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var resolver = resolver(session, temp.toRealPath());
        jdbc.update("UPDATE managed_workspace_access SET can_create = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
        jdbc.update("UPDATE managed_workspace_access SET can_create = TRUE, can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
        jdbc.update("UPDATE managed_workspace_access SET can_read = TRUE WHERE tenant_id = ?", session.tenantId());
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 2 WHERE session_id = ?", session.sessionId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE', deleted_at = NULL,"
                + " workspace_config_ref = 'unknown', context_config_ref = ? WHERE session_id = ?",
                digest("unknown\0" + WorkspaceExecutionProfile.POLICY_REF), session.sessionId());
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
    }

    @Test
    void refusesStaleSessionSnapshotAfterDeletionOrBindingChange() {
        SessionRecord snapshot = createSession("storage", "child");
        authority.authorize(snapshot);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 2"
                + " WHERE session_id = ?", snapshot.sessionId());
        assertUnavailable(() -> authority.authorize(snapshot));

        jdbc.update("UPDATE managed_agent_session SET status = 'ACTIVE', deleted_at = NULL,"
                + " workspace_storage_id = 'replacement' WHERE session_id = ?", snapshot.sessionId());
        assertUnavailable(() -> authority.authorize(snapshot));
    }

    @Test
    void authorizationRefusesAnUnverifiedPhysicalMount() {
        SessionRecord session = createSession("storage", ".");
        WorkspaceStorageGuard guard = mock(WorkspaceStorageGuard.class);
        var checked = new WorkspaceExecutionStore(new JdbcTemplate(dataSource),
                new DataSourceTransactionManager(dataSource), guard);
        doThrow(WorkspaceExecutionStore.unavailable()).when(guard).verify(session.workspace());
        assertUnavailable(() -> checked.authorize(session));
        checked.authorizePassiveAttachment(session);
        verify(guard).verify(session.workspace());
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> checked.authorizePassiveAttachment(session));
    }

    @Test
    void rejectsMissingReplacedSymlinkAndOverlappingMounts() throws Exception {
        SessionRecord session = createSession("storage", ".");
        Path root = Files.createDirectory(temp.resolve("root")).toRealPath();
        var resolver = resolver(session, root);
        Files.move(root, temp.resolve("old"));
        Files.createDirectory(root);
        assertUnavailable(() -> resolver.resolve(session.sessionId()));
        Path link = temp.resolve("link");
        Files.createSymbolicLink(link, root);
        assertThatThrownBy(() -> resolver(session, link)).isInstanceOf(IllegalStateException.class);
        var properties = properties(List.of(new WorkspaceMount(session.tenantId(), "storage", root.toString()),
                new WorkspaceMount("other-tenant", "other-storage", root.toString())));
        assertThatThrownBy(() -> new WorkspaceRuntimeResolver(sessions, authority, properties))
                .hasMessageContaining("overlap");
        var missing = new WorkspaceRuntimeResolver(sessions, authority, properties(List.of()));
        assertUnavailable(() -> missing.resolve(session.sessionId()));
    }

    @Test
    void serializesIndependentSqlClientsByStorageAndFencesStaleRelease() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var binding = session.workspace();
        RuntimeSessionRecord first = holder(session, "first");
        RuntimeSessionRecord second = holder(session, "second");
        var otherClient = new WorkspaceExecutionStore(new JdbcTemplate(dataSource), new DataSourceTransactionManager(dataSource));
        CyclicBarrier start = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> contend(authority, binding, first, start));
            var two = pool.submit(() -> contend(otherClient, binding, second, start));
            boolean won = one.get(5, TimeUnit.SECONDS);
            assertThat(two.get(5, TimeUnit.SECONDS)).isEqualTo(!won);
            var winner = won ? first : second;
            var loser = won ? second : first;
            otherClient.claim(binding, winner);
            authority.assertHeld(binding, winner);
            authority.release(binding, loser);
            assertBusy(() -> otherClient.claim(binding, loser));
            ContextBinding changedGeneration = new ContextBinding(binding.getTenantId(), "other-workspace", 2,
                    binding.getStorageId(), "child", binding.getContextConfigRef(), 1);
            assertUnavailable(() -> otherClient.claim(changedGeneration, loser));
            ContextBinding independentStorage = new ContextBinding(binding.getTenantId(), "other-workspace", 1,
                    "other-storage", ".", binding.getContextConfigRef(), 1);
            assertUnavailable(() -> otherClient.claim(independentStorage, loser));
            authority.release(binding, winner);
            otherClient.claim(binding, loser);
            authority.release(binding, winner);
            otherClient.assertHeld(binding, loser);
        }
    }

    @Test
    void fixedProfileMatchesCrossLanguageDigestDerivation() throws Exception {
        String refs = WorkspaceExecutionProfile.CONFIG_REF + "\0" + WorkspaceExecutionProfile.POLICY_REF;
        assertThat(digest(refs)).isEqualTo(WorkspaceExecutionProfile.CONTEXT_CONFIG_REF);
        assertThat(digest(WorkspaceExecutionProfile.PROFILE + "\0" + refs)).isEqualTo(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
    }

    @Test
    void releasesAnUnclaimedSessionWithoutActivatingItOrReleasingTheWorkspaceHolder() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var rival = holder(session, "holder");
        authority.claim(session.workspace(), rival);
        assertBusy(() -> fixture.transport().acquire(fixture.lease(), fixture.record().getSession()));
        var repository = new JdbcRuntimeSessionRepository(dataSource);
        var releasing = repository.compareAndSet(fixture.record(),
                fixture.record().withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        assertThat(releasing).isNotNull();
        assertThat(fixture.transport().release(fixture.lease(), releasing.getSession()).toCompletableFuture().join()).isTrue();
        authority.assertHeld(session.workspace(), rival);
        assertUnavailable(() -> authority.claim(session.workspace(), releasing));
        verify(fixture.http(), never()).installContext(any(), any(), any(), any());
        verify(fixture.http(), never()).activateWorkspace(any(), any(), any(), any(Boolean.class));
    }

    @Test
    void ambiguousAcquireAndReleaseRetainOwnershipAndStaleReleaseCannotUnlockNewTurn() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var binding = session.workspace();
        var runtimeSession = fixture.record().getSession();
        var rival = holder(session, "rival");
        when(fixture.http().installContext(any(), any(), any(), any()))
                .thenReturn(CompletableFuture.failedFuture(new IllegalStateException("lost response")));
        assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), runtimeSession).toCompletableFuture().join())
                .hasRootCauseMessage("lost response");
        assertBusy(() -> authority.claim(binding, rival));
        verify(fixture.http(), never()).activateWorkspace(any(), any(), any(), eq(true));
        when(fixture.http().installContext(any(), any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of()));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(true))).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().acquire(fixture.lease(), runtimeSession).toCompletableFuture().join();
        authority.assertHeld(binding, fixture.record());
        assertThat(new JdbcRuntimeSessionRepository(dataSource).compareAndSet(fixture.record(),
                fixture.record().withState(RuntimeSessionRecord.State.RELEASING, Instant.now()))).isNotNull();
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false)))
                .thenReturn(CompletableFuture.failedFuture(new IllegalStateException("lost release")));
        assertThatThrownBy(() -> fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join())
                .hasRootCauseMessage("lost release");
        assertBusy(() -> authority.claim(binding, rival));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false))).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join();
        authority.claim(binding, rival);
        fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join();
        authority.assertHeld(binding, rival);
    }

    @Test
    void postClaimAuthorityRefusalIsNotReportedAsAnUnclaimedWorkspace() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        when(fixture.http().installContext(any(), any(), any(), any()))
                .thenReturn(CompletableFuture.completedFuture(Map.of()));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(true))).thenAnswer(ignored -> {
            jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
            return CompletableFuture.completedFuture(null);
        });
        assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), fixture.record().getSession())
                .toCompletableFuture().join())
                .cause().isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("runtime_session_acquire_failed");
                    assertThat(error.getStatusCode()).isEqualTo(503);
                });
        authority.assertHeld(session.workspace(), fixture.record());
        assertBusy(() -> authority.claim(session.workspace(), holder(session, "rival")));
    }

    @Test
    void synchronousPostClaimFailureRemainsUncertain() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        when(fixture.http().installContext(any(), any(), any(), any()))
                .thenThrow(WorkspaceExecutionStore.unavailable());
        assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), fixture.record().getSession()))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error ->
                        assertThat(error.getCode()).isEqualTo("runtime_session_acquire_failed"));
        authority.assertHeld(session.workspace(), fixture.record());
    }

    // The shared directory rule also fences the acquire path before the
    // storage claim: a sealed directory refuses before installContext or
    // ownership.claim can run.
    @Test
    void refusesAnUnreadableSessionDirectoryBeforeClaimingStorage() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file
                .FileSystems.getDefault().supportedFileAttributeViews()
                .contains("posix"));
        SessionRecord session = createSession("storage", "sealed");
        java.nio.file.Path sealed = java.nio.file.Files.createDirectory(
                temp.resolve("sealed"));
        java.nio.file.Files.setPosixFilePermissions(sealed,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("---------"));
        org.junit.jupiter.api.Assumptions.assumeTrue(
                !java.nio.file.Files.isReadable(sealed)
                        || !java.nio.file.Files.isExecutable(sealed),
                "POSIX permission checks are not enforced for this uid");
        try {
            var fixture = transport(session);
            assertUnavailable(() -> fixture.transport().acquire(
                    fixture.lease(), fixture.record().getSession()));
            verify(fixture.http(), never()).installContext(any(), any(),
                    any(), any());
            // The ordering the name claims: no claim was recorded, so a
            // rival can still take the storage. A claim-before-validate
            // mutant strands the rival behind workspace_busy instead.
            authority.claim(session.workspace(), holder(session, "rival"));
        } finally {
            java.nio.file.Files.setPosixFilePermissions(sealed,
                    java.nio.file.attribute.PosixFilePermissions
                            .fromString("rwx------"));
        }
    }

    @Test
    void refusesMissingOrLinkedSessionDirectoryBeforeClaimingStorage() throws Exception {
        for (String cwd : List.of("missing", "link")) {
            SessionRecord session = createSession("storage", cwd);
            var fixture = transport(session);
            if (cwd.equals("link")) {
                Files.createSymbolicLink(temp.resolve("link"), Files.createDirectory(temp.resolve("outside")));
            }
            assertUnavailable(() -> fixture.transport().acquire(fixture.lease(), fixture.record().getSession()));
            verify(fixture.http(), never()).installContext(any(), any(), any(), any());
            authority.claim(session.workspace(), holder(session, "rival"));
        }
    }

    // The ENOTDIR shape on the acquire path: a persisted cwd under a plain
    // file is structural data, and the Turn must fail immediately with the
    // accurate terminal code — never 31 seconds of retries recorded as
    // hosted_harness_unavailable, nor a RECOVERY_BLOCKED park. assertUnavailable
    // pins both the code and isRetryable()==false, so folding the anomaly
    // into the probe's transient arm here reddens this test.
    @Test
    void refusesAPlainFileDescendantCwdTerminallyBeforeClaimingStorage() throws Exception {
        Files.writeString(temp.resolve("plain-file"), "nothing inside");
        SessionRecord session = createSession("storage", "plain-file/sub");
        var fixture = transport(session);
        assertUnavailable(() -> fixture.transport().acquire(
                fixture.lease(), fixture.record().getSession()));
        verify(fixture.http(), never()).installContext(any(), any(), any(), any());
        authority.claim(session.workspace(), holder(session, "rival"));
    }

    @Test
    void routesCapturedShellAndOriginalCleanupThroughV3AfterRevocation() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        Map<String, Object> publisher = Map.of("url", "http://127.0.0.1:1234/internal/hosted-shell-publisher/v1",
                "token", "a".repeat(43));
        when(fixture.http().installPublisherV3(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().installPublisher(fixture.lease(), runtimeSession, publisher).toCompletableFuture().join();
        Map<String, Object> reference = Map.of("sessionId", runtimeSession.getRuntimeSessionId(), "promptId", "turn",
                "callId", "worker-call", "argsDigest", "sha256:" + "a".repeat(64), "runtimeProtocol", 3,
                "inputDigest", "b".repeat(64), "executionCallId", "execution", "toolName", "run_shell_command",
                "input", Map.of("command", "pwd"));
        Map<String, Object> result = Map.of("executionStatus", "success", "responseParts", List.of());
        Map<String, Object> response = Map.of("protocolVersion", 3, "toolResult", "managed-tool-result/1",
                "state", "settled", "lastSequence", 2, "result", result);
        when(fixture.http().executeV3(any(), any(), any(), any())).thenReturn(CompletableFuture.completedFuture(response));
        assertThat(fixture.transport().execute(fixture.lease(), runtimeSession, reference).toCompletableFuture().join())
                .isEqualTo(result);
        @SuppressWarnings({"rawtypes", "unchecked"})
        ArgumentCaptor<Map<String, Object>> wire = ArgumentCaptor.forClass((Class) Map.class);
        @SuppressWarnings({"rawtypes", "unchecked"})
        ArgumentCaptor<Map<String, Object>> capture = ArgumentCaptor.forClass((Class) Map.class);
        verify(fixture.http()).executeV3(eq(fixture.lease()), eq(runtimeSession), wire.capture(), capture.capture());
        assertThat(wire.getValue()).containsEntry("argsDigest", "b".repeat(64))
                .doesNotContainKeys("runtimeProtocol", "inputDigest", "executionCallId");
        assertThat(capture.getValue()).containsEntry("sessionId", session.sessionId())
                .containsEntry("tenantId", session.tenantId()).containsEntry("bindingGeneration", "1")
                .containsEntry("executionCallId", "execution");
        verify(fixture.http(), never()).execute(any(), any(), any());
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> fixture.transport().installPublisher(fixture.lease(), runtimeSession, publisher));
        when(fixture.http().statusV3(any(), any(), any(), eq(0L))).thenReturn(CompletableFuture.completedFuture(response));
        when(fixture.http().cancelV3(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(response));
        when(fixture.http().acknowledgeV3(any(), any(), any(), any())).thenReturn(CompletableFuture.completedFuture(response));
        Map<String, Object> status = Map.of("state", "settled", "result", result);
        assertThat(fixture.transport().status(fixture.lease(), runtimeSession, reference, 0).toCompletableFuture().join()).isEqualTo(status);
        assertThat(fixture.transport().cancel(fixture.lease(), runtimeSession, reference).toCompletableFuture().join()).isEqualTo(status);
        assertThat(fixture.transport().acknowledge(fixture.lease(), runtimeSession, reference, Map.of()).toCompletableFuture().join()).isEqualTo(status);
    }

    @Test
    void rechecksAuthorityBeforeNewDispatchButAllowsOriginalCleanupAfterRevocation() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertThat(fixture.transport().execute(fixture.lease(), runtimeSession, Map.of()).toCompletableFuture().join())
                .containsEntry("executionStatus", "not_started")
                .containsEntry("error", Map.of("type", "workspace_unavailable",
                        "message", "Workspace execution was refused before dispatch."));
        assertThat(fixture.transport().execute(fixture.lease(), runtimeSession,
                Map.of("dispatchMode", "deferred"), Map.of("toolName", "write_file", "input", Map.of()))
                .toCompletableFuture().join()).containsEntry("executionStatus", "not_started");
        verify(fixture.http(), never()).execute(any(), any(), any());
        verify(fixture.http(), never()).execute(any(), any(), any(), any());
        when(fixture.http().cancel(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        when(fixture.http().status(any(), any(), any(), eq(0L))).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false))).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().cancel(fixture.lease(), runtimeSession, Map.of()).toCompletableFuture().join();
        fixture.transport().status(fixture.lease(), runtimeSession, Map.of(), 0).toCompletableFuture().join();
        assertThat(fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join()).isTrue();
        authority.claim(session.workspace(), holder(session, "next"));
    }

    @Test
    void mcpAdmissionRequiresOwnershipAndRecoveryUsesTheOriginalOwnerAfterRevocation() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        Map<String, Object> configure = mcpControl(session, "mcp-configure");
        assertBusy(() -> fixture.transport().control(fixture.lease(), runtimeSession, configure));
        verify(fixture.http(), never()).control(any(), any(), any());
        authority.claim(session.workspace(), fixture.record());
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "running")));
        assertThat(fixture.transport().control(fixture.lease(), runtimeSession, configure).toCompletableFuture().join())
                .isEqualTo(Map.of("state", "running"));
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        for (String kind : List.of("mcp-configure", "mcp-discover")) {
            assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, mcpControl(session, kind)));
        }
        for (String kind : List.of("mcp-status", "mcp-cancel", "mcp-release")) {
            Map<String, Object> operation = mcpControl(session, kind);
            fixture.transport().control(fixture.lease(), runtimeSession, operation).toCompletableFuture().join();
            verify(fixture.http()).control(fixture.lease(), runtimeSession, operation);
        }
        authority.assertHeld(session.workspace(), fixture.record());
    }

    @Test
    void mcpRecoveryKeepsExactOwnershipWhenTheVerifiedMountIsUnavailable() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        WorkspaceStorageGuard guard = mock(WorkspaceStorageGuard.class);
        var checked = new WorkspaceExecutionStore(new JdbcTemplate(dataSource),
                new DataSourceTransactionManager(dataSource), guard);
        doThrow(WorkspaceExecutionStore.unavailable()).when(guard).verify(session.workspace());
        var transport = new WorkspaceRuntimeTransport(fixture.http(), resolver(session, temp.toRealPath()),
                checked, fixture.bindings(), new JdbcRuntimeSessionRepository(dataSource));
        assertUnavailable(() -> transport.control(fixture.lease(), runtimeSession, mcpControl(session, "mcp-configure")));
        verify(fixture.http(), never()).control(any(), any(), any());
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        String storageKey = digest(session.tenantId() + "\0" + session.workspace().getStorageId())
                .substring("sha256:".length());
        var originalHolder = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        for (String kind : List.of("mcp-status", "mcp-cancel", "mcp-release")) {
            Map<String, Object> operation = mcpControl(session, kind);
            transport.control(fixture.lease(), runtimeSession, operation).toCompletableFuture().join();
            verify(fixture.http()).control(fixture.lease(), runtimeSession, operation);
        }
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey)).isEqualTo(originalHolder);
        jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = 'another-owner' WHERE storage_key = ?", storageKey);
        assertBusy(() -> transport.control(fixture.lease(), runtimeSession, mcpControl(session, "mcp-status")));
    }

    @Test
    void mcpLookupCannotUseAReplacedLeaseOrLostRuntime() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        Map<String, Object> lookup = mcpControl(session, "mcp-status");
        RuntimeLease changed = new RuntimeLease("replacement", fixture.lease().getEndpoint(), fixture.lease().getToken(),
                fixture.lease().getLeaseId(), fixture.lease().getEpoch() + 1);
        assertUnavailable(() -> fixture.transport().control(changed, runtimeSession, lookup));
        assertThat(fixture.bindings().compareAndSet(fixture.runtime(),
                fixture.runtime().withState(RuntimeBindingRecord.State.LOST, fixture.lease(), Instant.now()))).isNotNull();
        assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, lookup));
        verify(fixture.http(), never()).control(any(), any(), any());
        authority.assertHeld(session.workspace(), fixture.record());
    }

    @Test
    void hookAdmissionRequiresOwnershipAndRecoveryUsesTheOriginalOwnerAfterRevocation() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        Map<String, Object> configure = hookControl(session, "hook-execute");
        assertBusy(() -> fixture.transport().control(fixture.lease(), runtimeSession, configure));
        verify(fixture.http(), never()).control(any(), any(), any());
        authority.claim(session.workspace(), fixture.record());
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "running")));
        assertThat(fixture.transport().control(fixture.lease(), runtimeSession, configure).toCompletableFuture().join())
                .isEqualTo(Map.of("state", "running"));
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        for (String kind : List.of("hook-execute", "hook-catalog")) {
            assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, hookControl(session, kind)));
        }
        for (String kind : List.of("hook-status", "hook-cancel")) {
            Map<String, Object> operation = hookControl(session, kind);
            fixture.transport().control(fixture.lease(), runtimeSession, operation).toCompletableFuture().join();
            verify(fixture.http()).control(fixture.lease(), runtimeSession, operation);
        }
        authority.assertHeld(session.workspace(), fixture.record());
    }

    @Test
    void hookLookupCannotUseAReplacedLeaseOrLostRuntime() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        Map<String, Object> lookup = hookControl(session, "hook-status");
        RuntimeLease changed = new RuntimeLease("replacement", fixture.lease().getEndpoint(), fixture.lease().getToken(),
                fixture.lease().getLeaseId(), fixture.lease().getEpoch() + 1);
        assertUnavailable(() -> fixture.transport().control(changed, runtimeSession, lookup));
        assertThat(fixture.bindings().compareAndSet(fixture.runtime(),
                fixture.runtime().withState(RuntimeBindingRecord.State.LOST, fixture.lease(), Instant.now()))).isNotNull();
        assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, lookup));
        verify(fixture.http(), never()).control(any(), any(), any());
        authority.assertHeld(session.workspace(), fixture.record());
    }

    @Test
    void legacyCloseHooksUseTheOriginalRuntimeAndStillCheckCurrentAuthorization() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        long now = System.currentTimeMillis();
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSING' WHERE tenant_id = ? AND session_id = ?",
                session.tenantId(), session.sessionId());
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state, admission_stage, delivery_state, session_status_before, lease_until,"
                + " available_at, created_at, updated_at) VALUES (?, ?, ?, 'CLOSE', 'actor', 'close', 'digest', 'PENDING',"
                + " 'ACCEPTED', 'LEASED', 'ACTIVE', ?, ?, ?, ?)", session.tenantId(), session.sessionId(), UUID.randomUUID().toString(),
                now + 60_000, now, now, now);
        fixture.bindings().requestHarnessDrain(session.tenantId(), session.sessionId());
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        for (String kind : List.of("hook-execute", "hook-catalog")) {
            Map<String, Object> hook = hookControl(session, kind);
            fixture.transport().control(fixture.lease(), runtimeSession, hook).toCompletableFuture().join();
            verify(fixture.http()).control(fixture.lease(), runtimeSession, hook);
        }
        assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, mcpControl(session, "mcp-configure")));
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, hookControl(session, "hook-execute")));
        fixture.transport().control(fixture.lease(), runtimeSession, hookControl(session, "hook-status")).toCompletableFuture().join();
        authority.assertHeld(session.workspace(), fixture.record());
    }

    private static Map<String, Object> hookControl(SessionRecord session, String kind) {
        return Map.of("kind", kind, "operationId", kind,
                "sessionKey", Map.of("tenantId", session.tenantId(),
                        "workspaceId", session.workspace().getWorkspaceId(), "sessionId", session.sessionId()));
    }

    private static Map<String, Object> mcpControl(SessionRecord session, String kind) {
        return Map.of("kind", kind, "operationId", kind,
                "sessionKey", Map.of("tenantId", session.tenantId(),
                        "workspaceId", session.workspace().getWorkspaceId(), "sessionId", session.sessionId()));
    }

    @Test
    void v3OriginalControlSurvivesWorkspaceAuthorizationLossWithoutNewDispatch() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        Map<String, Object> original = Map.of("callId", "original");
        when(fixture.http().statusV3(any(), any(), any(), eq(0L)))
                .thenReturn(CompletableFuture.completedFuture(Map.of("state", "executing")));
        when(fixture.http().cancelV3(any(), any(), any()))
                .thenReturn(CompletableFuture.completedFuture(Map.of("state", "cancel_requested")));
        when(fixture.http().acknowledgeV3(any(), any(), any(), any()))
                .thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        assertThat(fixture.transport().statusV3(fixture.lease(), runtimeSession, original, 0)
                .toCompletableFuture().join()).containsEntry("state", "executing");
        assertThat(fixture.transport().cancelV3(fixture.lease(), runtimeSession, original)
                .toCompletableFuture().join()).containsEntry("state", "cancel_requested");
        assertThat(fixture.transport().acknowledgeV3(fixture.lease(), runtimeSession, original, Map.of())
                .toCompletableFuture().join()).containsEntry("state", "settled");
        Map<String, Object> refusal = fixture.transport().executeV3(fixture.lease(), runtimeSession,
                original, Map.of(), Map.of()).toCompletableFuture().join();
        assertThat(refusal).containsEntry("state", "settled");
        Map<?, ?> result = (Map<?, ?>) refusal.get("result");
        assertThat(result.get("executionStatus")).isEqualTo("not_started");
        assertThat(result.get("capture")).isNull();
        assertThat(result.get("error")).isEqualTo(Map.of("type", "workspace_unavailable",
                "message", "Workspace execution was refused before dispatch."));
        verify(fixture.http(), never()).executeV3(any(), any(), any(), any(), any());
    }

    @Test
    void controlsRecheckWorkspaceAuthorityAndReleaseWaitsForProviderCleanup() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var runtimeSession = fixture.record().getSession();
        authority.claim(session.workspace(), fixture.record());
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of()));
        fixture.transport().control(fixture.lease(), runtimeSession, Map.of("kind", "manifest"))
                .toCompletableFuture().join();
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?", session.tenantId());
        assertUnavailable(() -> fixture.transport().control(fixture.lease(), runtimeSession, Map.of("kind", "prepare")));
        verify(fixture.http(), never()).control(any(), any(), eq(Map.of("kind", "prepare")));
        fixture.transport().control(fixture.lease(), runtimeSession, Map.of("kind", "history"))
                .toCompletableFuture().join();
        when(fixture.http().release(any(), any())).thenReturn(CompletableFuture.failedFuture(new IllegalStateException("busy")));
        assertThatThrownBy(() -> fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join())
                .hasRootCauseMessage("busy");
        verify(fixture.http(), never()).activateWorkspace(any(), any(), any(), eq(false));
        authority.assertHeld(session.workspace(), fixture.record());
        when(fixture.http().release(any(), any())).thenReturn(CompletableFuture.completedFuture(true));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false)))
                .thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join();
        var order = inOrder(fixture.http());
        order.verify(fixture.http(), org.mockito.Mockito.times(2)).release(fixture.lease(), runtimeSession);
        order.verify(fixture.http()).activateWorkspace(any(), any(), any(), eq(false));
        authority.claim(session.workspace(), holder(session, "next"));
    }

    @Test
    void lateDeactivationCannotClearAHolderAfterTheLossFence() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        var rival = holder(session, "rival");
        authority.claim(session.workspace(), fixture.record());
        var deactivation = new CompletableFuture<Void>();
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false))).thenReturn(deactivation);
        var releasing = fixture.transport().release(fixture.lease(), fixture.record().getSession()).toCompletableFuture();
        RuntimeBindingRecord lost = fixture.bindings().compareAndSet(fixture.runtime(),
                fixture.runtime().withState(RuntimeBindingRecord.State.LOST, fixture.lease(), Instant.now()));
        assertThat(lost).isNotNull();
        deactivation.complete(null);
        assertThatThrownBy(releasing::join).hasRootCauseInstanceOf(RuntimeBrokerException.class);
        authority.assertHeld(session.workspace(), fixture.record());
        assertBusy(() -> authority.claim(session.workspace(), rival));
    }

    @Test
    void closingReleasePreservesTheNewSharedHolderWithoutCurrentAuthorization() throws Exception {
        SessionRecord session = createSession("storage", ".");
        var fixture = transport(session);
        authority.claim(session.workspace(), fixture.record());
        var created = sessions.insertWorkspaceSessionCommand(session.tenantId(), "actor", "rival-create",
                "sha256:" + "b".repeat(64), "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("workspace", "."));
        var rival = holder(sessions.requireSession(session.tenantId(), created.sessionId()), "rival");
        authority.release(session.workspace(), fixture.record());
        authority.claim(session.workspace(), rival);
        assertThat(fixture.bindings().compareAndSet(fixture.runtime(), fixture.runtime()
                .withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, fixture.lease(), Instant.now()))).isNotNull();
        assertThat(new JdbcRuntimeSessionRepository(dataSource).compareAndSet(fixture.record(), fixture.record()
                .withState(RuntimeSessionRecord.State.RELEASING, Instant.now()))).isNotNull();
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSING' WHERE tenant_id = ? AND session_id = ?",
                session.tenantId(), session.sessionId());
        jdbc.update("DELETE FROM managed_workspace_access WHERE tenant_id = ?", session.tenantId());
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false)))
                .thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().release(fixture.lease(), fixture.record().getSession()).toCompletableFuture().join();
        assertThat(authority.isHeld(session.workspace(), rival)).isTrue();
        assertThat(authority.hasHolder(fixture.runtime())).isFalse();
        verify(fixture.http()).release(any(), any());
        verify(fixture.http()).activateWorkspace(any(), any(), any(), eq(false));
    }

    private TransportFixture transport(SessionRecord session) throws Exception {
        var resolver = resolver(session, temp.toRealPath());
        var resolved = resolver.resolve(session.sessionId());
        var runtimeSession = new RuntimeSession(session.sessionId(), UUID.randomUUID().toString(), "bootstrap", resolved.scope());
        var request = new RuntimeProvisionRequest(resolved.scope(), session.sessionId(), "local-process", "storage");
        var bindings = bindings();
        var runtime = readyBinding(bindings, request);
        var lease = runtime.getLease();
        var record = new RuntimeSessionRecord(runtimeSession, runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        var runtimeSessions = new JdbcRuntimeSessionRepository(dataSource);
        record = bindings.admitSession(runtimeSessions, record);
        var http = mock(HttpRuntimeTransport.class);
        when(http.release(any(), any())).thenReturn(CompletableFuture.completedFuture(true));
        return new TransportFixture(new WorkspaceRuntimeTransport(http, resolver, authority, bindings, runtimeSessions),
                http, record, lease, runtime, bindings);
    }

    private record TransportFixture(WorkspaceRuntimeTransport transport, HttpRuntimeTransport http,
            RuntimeSessionRecord record, RuntimeLease lease, RuntimeBindingRecord runtime,
            RuntimeBindingRepository bindings) {
    }

    private JdbcRuntimeBindingRepository bindings() {
        return new JdbcRuntimeBindingRepository(dataSource, new AesGcmSecretProtector("test-key", new byte[32]));
    }

    private static RuntimeBindingRecord readyBinding(RuntimeBindingRepository bindings, RuntimeProvisionRequest request) {
        return readyBinding(bindings, request, 1);
    }

    private static RuntimeBindingRecord readyBinding(RuntimeBindingRepository bindings,
            RuntimeProvisionRequest request, int handleVersion) {
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "test", Duration.ofMinutes(5));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        return bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle("local-process", handleVersion, Map.of("provider", "local-process")),
                Instant.now(), Instant.now()));
    }

    private boolean contend(WorkspaceExecutionStore store, ContextBinding binding,
            RuntimeSessionRecord holder, CyclicBarrier barrier) throws Exception {
        barrier.await(5, TimeUnit.SECONDS);
        try {
            store.claim(binding, holder);
            return true;
        } catch (RuntimeBrokerException error) {
            assertThat(error.getCode()).isEqualTo("workspace_busy");
            assertThat(error.isRetryable()).isTrue();
            return false;
        }
    }

    private SessionRecord createSession(String storage, String cwd) {
        String tenant = "tenant-" + UUID.randomUUID();
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, ?,"
                + " 'Workspace', ?, ?, 'ACTIVE')", tenant, storage, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        var created = sessions.insertWorkspaceSessionCommand(tenant, "actor", "create", "sha256:" + "a".repeat(64),
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", cwd));
        return sessions.findSessionById(created.sessionId()).orElseThrow();
    }

    private WorkspaceRuntimeResolver resolver(SessionRecord session, Path root) {
        return new WorkspaceRuntimeResolver(sessions, authority, properties(List.of(
                new WorkspaceMount(session.tenantId(), session.workspace().getStorageId(), root.toString()))));
    }

    private static ManagedAgentProperties properties(List<WorkspaceMount> mounts) {
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setWorkspaceMounts(mounts);
        return properties;
    }

    private RuntimeSessionRecord holder(SessionRecord session, String id) {
        var binding = session.workspace();
        var scope = new RuntimeScope(session.tenantId(), binding.getWorkspaceId(), "1", temp.toString(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var runtime = readyBinding(bindings(), new RuntimeProvisionRequest(scope, id, "local-process",
                binding.getStorageId()));
        return bindings().admitSession(new JdbcRuntimeSessionRepository(dataSource),
                new RuntimeSessionRecord(new RuntimeSession(session.sessionId(), id, "bootstrap", scope),
                        runtime.getBindingId(), runtime.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
    }

    private static String digest(String text) throws Exception {
        return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    // Every refusal this helper names is the structural, terminal verdict:
    // a retryable workspace_unavailable at any of these call sites is a
    // silently re-classified acquire path, and this is where it goes red.
    private static void assertUnavailable(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isFalse();
                });
    }

    private static void assertBusy(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
    }
}
