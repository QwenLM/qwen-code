package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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
                        + " qwen_runtime_harness_drain", String.class))
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
                        + " qwen_runtime_harness_drain", String.class))
                .isEqualTo(readmitted.id());
        assertThat(jdbc.queryForObject("SELECT phase FROM"
                        + " qwen_runtime_harness_drain", String.class))
                .isEqualTo("LIFECYCLE_ONLY");
    }

    // A store with the Workspace-files deployment flag on, plus the
    // registry and access rows a bound Session's admission resolves.
    private ManagedAgentStore workspaceStore() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore store = store(properties);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, 'workspace', 1, 'storage',"
                        + " 'Workspace', ?, ?, 'ACTIVE')",
                TENANT, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, 'workspace', ?, 'OPERATOR')",
                TENANT, "owner".getBytes(StandardCharsets.UTF_8));
        return store;
    }

    private ManagedAgentStore store(ManagedAgentProperties properties) {
        dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:lifecycle-resume-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
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
        }, ignored -> {
        }, new ManagedWorkspaceRegistry(jdbc), properties);
    }
}
