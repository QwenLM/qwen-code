package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * A resumed admission re-pins the failed operation's lifecycle protocol
 * (review round 9 re-review, R9-3): the Session parked in the pending
 * status by a terminal fail no longer passes the ACTIVE gate the service's
 * protocol choice reads, so without the pin a failed v1 close resumes as
 * protocol 0 and the parked v1 fence row is never rebound.
 */
class SessionLifecycleServiceResumeTest {
    private static final String TENANT = "lifecycle-resume";
    private final AtomicLong now = new AtomicLong(1_000);
    private JdbcTemplate jdbc;
    private JdbcDataSource dataSource;

    @Test
    void aFailedV1CloseResumesUnderProtocol1ThroughTheService() {
        ManagedAgentStore store = workspaceStore();
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String sessionId = transactions.execute(ignored ->
                store.insertWorkspaceSessionCommand(TENANT, "owner", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", ".")).sessionId());
        // The first close runs v1 and fails terminally: the Session parks in
        // CLOSING and the fence row keeps the claim released.
        String firstOperation = store.beginWorkspaceLifecycle(TENANT,
                sessionId, OperationKind.CLOSE, "owner", "a".repeat(64),
                "close", "digest", true, 1).operation().operationId();
        OperationRecord claimed = store.claimOperation(TENANT, sessionId,
                firstOperation, "worker", Duration.ofSeconds(30))
                .orElseThrow();
        assertThat(store.failOperation(TENANT, sessionId, firstOperation,
                "worker", claimed.claimGeneration(),
                "session_lifecycle_delivery_failed")).isTrue();
        assertThat(store.requireSession(TENANT, sessionId).status())
                .isEqualTo("CLOSING");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM"
                        + " ma_session_head", String.class))
                .isNull();

        ManagedAgentService sessions = mock(ManagedAgentService.class);
        when(sessions.lifecycleDigest(anyString(), anyString()))
                .thenReturn("digest");
        SessionLifecycleCoordinator coordinator =
                mock(SessionLifecycleCoordinator.class);
        when(coordinator.supportsWorkspaceLifecycle()).thenReturn(true);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        SessionLifecycleService service = new SessionLifecycleService(store,
                sessions, new RequestDigests(), coordinator);
        service.setRuntimeWarmer(runtimeWarmer);

        var readmitted = service.admitPublic(TENANT, "owner", "close-2",
                sessionId, OperationKind.CLOSE);

        // The service's ACTIVE gate computed protocol 0 for the parked
        // Session; the store re-pins the failed close's protocol 1, and the
        // parked fence row rebinds to the new operation instead of a
        // duplicate v0 row being inserted.
        var operation = store.findOperation(TENANT, sessionId,
                readmitted.id()).orElseThrow();
        assertThat(operation.lifecycleProtocolVersion()).isEqualTo(1);
        assertThat(operation.sessionStatusBefore()).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM"
                        + " ma_session_head", String.class))
                .isEqualTo(readmitted.id());
        assertThat(jdbc.queryForObject("SELECT phase FROM"
                        + " ma_session_head", String.class))
                .isEqualTo("LIFECYCLE_ONLY");
    }

    // A failed workspace DELETE parks the Session in DELETING, which the
    // workspace status gate refused before the resume branch could run
    // (review round 13, R13-2). The resume is recognized before the gate:
    // the failed delete's protocol is pinned, the open-operation barrier
    // still holds, and a second live lifecycle operation stays refused.
    @Test
    void aFailedV1DeleteResumesThroughThePublicService() {
        ManagedAgentStore store = workspaceStore();
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String sessionId = transactions.execute(ignored ->
                store.insertWorkspaceSessionCommand(TENANT, "owner", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", ".")).sessionId());
        // The first delete runs v1 against the ACTIVE Session and fails
        // terminally: the Session parks in DELETING and the fence row keeps
        // the claim released.
        String firstOperation = store.beginWorkspaceLifecycle(TENANT,
                sessionId, OperationKind.DELETE, "owner", "a".repeat(64),
                "delete", "digest", true, 1).operation().operationId();
        OperationRecord claimed = store.claimOperation(TENANT, sessionId,
                firstOperation, "worker", Duration.ofSeconds(30))
                .orElseThrow();
        assertThat(store.failOperation(TENANT, sessionId, firstOperation,
                "worker", claimed.claimGeneration(),
                "session_lifecycle_delivery_failed")).isTrue();
        assertThat(store.requireSession(TENANT, sessionId).status())
                .isEqualTo("DELETING");

        ManagedAgentService sessions = mock(ManagedAgentService.class);
        when(sessions.lifecycleDigest(anyString(), anyString()))
                .thenReturn("digest");
        SessionLifecycleCoordinator coordinator =
                mock(SessionLifecycleCoordinator.class);
        when(coordinator.supportsWorkspaceLifecycle()).thenReturn(true);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        SessionLifecycleService service = new SessionLifecycleService(store,
                sessions, new RequestDigests(), coordinator);
        service.setRuntimeWarmer(runtimeWarmer);

        var readmitted = service.admitPublic(TENANT, "owner", "delete-2",
                sessionId, OperationKind.DELETE);

        // The service computed protocol 0 for the parked Session; the store
        // re-pins the failed delete's protocol 1, carries the failed one's
        // original pre-operation status, and rebinds the parked fence row.
        var operation = store.findOperation(TENANT, sessionId,
                readmitted.id()).orElseThrow();
        assertThat(operation.lifecycleProtocolVersion()).isEqualTo(1);
        assertThat(operation.sessionStatusBefore()).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM"
                        + " ma_session_head", String.class))
                .isEqualTo(readmitted.id());
        // The resumed delete is open, so a second live lifecycle operation
        // is still refused by the open-operation barrier.
        assertThatThrownBy(() -> service.admitPublic(TENANT, "owner",
                "delete-3", sessionId, OperationKind.DELETE))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("session_operation_active"));
    }

    // A settle that saved its effects moved the fence to DRAINING before
    // the terminal fail, and failOperation only releases a LIFECYCLE_ONLY
    // claim: the fence stayed bound to the dead operation, so the resumed
    // close was fenced out of its own recovery with
    // workspace_lifecycle_claim_fenced (review round 13, R13-1). The
    // re-admission rebinds the DRAINING fence and carries the validated
    // effects receipt, so the resumed close can finish.
    @Test
    void aFailedCloseWhoseEffectsReachedDrainingResumesAndFinishes() {
        ManagedAgentStore store = workspaceStore();
        ObjectProvider<RuntimeBindingRepository> bindings =
                mock(ObjectProvider.class);
        when(bindings.getIfAvailable())
                .thenReturn(mock(RuntimeBindingRepository.class));
        WorkspaceLifecycleStore lifecycle = new WorkspaceLifecycleStore(jdbc,
                new ObjectMapper(), bindings);
        store.setWorkspaceLifecycleStore(lifecycle);
        var transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String sessionId = transactions.execute(ignored ->
                store.insertWorkspaceSessionCommand(TENANT, "owner", "create",
                        "digest", "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("workspace", ".")).sessionId());
        // The first close runs v1, persists its effects receipt — the fence
        // moves to DRAINING — and only then fails terminally.
        String firstOperation = store.beginWorkspaceLifecycle(TENANT,
                sessionId, OperationKind.CLOSE, "owner", "a".repeat(64),
                "close", "digest", true, 1).operation().operationId();
        OperationRecord claimed = store.claimOperation(TENANT, sessionId,
                firstOperation, "worker", Duration.ofSeconds(30))
                .orElseThrow();
        JsonNode effects = lifecycle.recoverEffects(claimed);
        assertThat(effects.path("neverInitialized").asBoolean()).isTrue();
        assertThat(jdbc.queryForObject("SELECT phase FROM"
                        + " ma_session_head", String.class))
                .isEqualTo("DRAINING");
        assertThat(store.failOperation(TENANT, sessionId, firstOperation,
                "worker", claimed.claimGeneration(),
                "session_close_completion_unsettled")).isTrue();
        // The terminal write could not release the DRAINING fence: it still
        // names the dead operation.
        assertThat(jdbc.queryForObject("SELECT operation_id FROM"
                        + " ma_session_head", String.class))
                .isEqualTo(firstOperation);

        ManagedAgentService sessions = mock(ManagedAgentService.class);
        when(sessions.lifecycleDigest(anyString(), anyString()))
                .thenReturn("digest");
        SessionLifecycleCoordinator coordinator =
                mock(SessionLifecycleCoordinator.class);
        when(coordinator.supportsWorkspaceLifecycle()).thenReturn(true);
        RuntimeWarmer runtimeWarmer = mock(RuntimeWarmer.class);
        when(runtimeWarmer.supportsWorkspaceClose()).thenReturn(true);
        SessionLifecycleService service = new SessionLifecycleService(store,
                sessions, new RequestDigests(), coordinator);
        service.setRuntimeWarmer(runtimeWarmer);

        var readmitted = service.admitPublic(TENANT, "owner", "close-2",
                sessionId, OperationKind.CLOSE);

        // The parked DRAINING fence rebinds to the resumed close, and the
        // validated effects receipt moves with it.
        var operation = store.findOperation(TENANT, sessionId,
                readmitted.id()).orElseThrow();
        assertThat(operation.lifecycleProtocolVersion()).isEqualTo(1);
        assertThat(operation.sessionStatusBefore()).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM"
                        + " ma_session_head", String.class))
                .isEqualTo(readmitted.id());
        assertThat(jdbc.queryForObject("SELECT phase FROM"
                        + " ma_session_head", String.class))
                .isEqualTo("DRAINING");
        assertThat(jdbc.queryForObject(
                "SELECT lifecycle_effects_receipt_json FROM"
                        + " ma_operation WHERE operation_id = ?",
                String.class, readmitted.id()))
                .isEqualTo(effects.toString());

        // The resumed close recovers the carried effects instead of being
        // fenced out, and its completion verifies them and finishes.
        OperationRecord reclaimed = store.claimOperation(TENANT, sessionId,
                readmitted.id(), "worker", Duration.ofSeconds(30))
                .orElseThrow();
        JsonNode recovered = lifecycle.recoverEffects(reclaimed);
        assertThat(recovered.path("neverInitialized").asBoolean()).isTrue();
        assertThat(store.completeOperation(TENANT, sessionId,
                readmitted.id(), "worker", reclaimed.claimGeneration(), true))
                .isTrue();
        assertThat(store.requireSession(TENANT, sessionId).status())
                .isEqualTo("CLOSED");
        assertThat(store.findOperation(TENANT, sessionId, readmitted.id())
                .orElseThrow().state()).isEqualTo("COMPLETED");
    }

    // A store with the Workspace-files deployment flag on, plus the
    // registry and access rows a bound Session's admission resolves.
    private ManagedAgentStore workspaceStore() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore store = store(properties);
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, 'workspace', 1, 'storage',"
                        + " 'Workspace', ?, ?, 'ACTIVE')",
                TENANT, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, 'workspace', ?, 'OPERATOR')",
                TENANT, "owner".getBytes(StandardCharsets.UTF_8));
        return store;
    }

    private ManagedAgentStore store(ManagedAgentProperties properties) {
        dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:lifecycle-resume-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        return new ManagedAgentStore(jdbc, new ObjectMapper(), new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }
        }, ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
    }
}
