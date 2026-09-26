package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

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
            assertBusy(() -> otherClient.claim(changedGeneration, loser));
            ContextBinding independentStorage = new ContextBinding(binding.getTenantId(), "other-workspace", 1,
                    "other-storage", ".", binding.getContextConfigRef(), 1);
            otherClient.claim(independentStorage, loser);
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
        verify(fixture.http(), never()).execute(any(), any(), any());
        when(fixture.http().cancel(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        when(fixture.http().status(any(), any(), any(), eq(0L))).thenReturn(CompletableFuture.completedFuture(Map.of("state", "settled")));
        when(fixture.http().activateWorkspace(any(), any(), any(), eq(false))).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().cancel(fixture.lease(), runtimeSession, Map.of()).toCompletableFuture().join();
        fixture.transport().status(fixture.lease(), runtimeSession, Map.of(), 0).toCompletableFuture().join();
        assertThat(fixture.transport().release(fixture.lease(), runtimeSession).toCompletableFuture().join()).isTrue();
        authority.claim(session.workspace(), holder(session, "next"));
    }

    private TransportFixture transport(SessionRecord session) throws Exception {
        var resolver = resolver(session, temp.toRealPath());
        var resolved = resolver.resolve(session.sessionId());
        var runtimeSession = new RuntimeSession(session.sessionId(), UUID.randomUUID().toString(), "bootstrap", resolved.scope());
        var record = new RuntimeSessionRecord(runtimeSession, "binding", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        var request = new RuntimeProvisionRequest(resolved.scope(), session.sessionId(), "local-process", "storage");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        Instant now = Instant.now();
        var runtime = new RuntimeBindingRecord("binding", request, seed, 1, RuntimeBindingRecord.State.READY, lease,
                new RuntimeResourceHandle("local-process", 1, Map.of("provider", "local-process")), 1, false, null, null, 0, 0, now, now, now);
        var runtimeSessions = mock(RuntimeSessionRepository.class);
        var bindings = mock(RuntimeBindingRepository.class);
        when(runtimeSessions.findById(resolved.scope(), runtimeSession.getRuntimeSessionId())).thenReturn(record);
        when(bindings.findById("binding")).thenReturn(runtime);
        var http = mock(HttpRuntimeTransport.class);
        return new TransportFixture(new WorkspaceRuntimeTransport(http, resolver, authority, bindings, runtimeSessions), http, record, lease);
    }

    private record TransportFixture(WorkspaceRuntimeTransport transport, HttpRuntimeTransport http,
            RuntimeSessionRecord record, RuntimeLease lease) {
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
                "qwen-code", null, List.of(), null, new WorkspaceSelection("workspace", cwd));
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
        return new RuntimeSessionRecord(new RuntimeSession(session.sessionId(), id, "bootstrap", scope),
                "binding-" + id, 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private static String digest(String text) throws Exception {
        return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static void assertUnavailable(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
    }

    private static void assertBusy(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_busy"));
    }
}
