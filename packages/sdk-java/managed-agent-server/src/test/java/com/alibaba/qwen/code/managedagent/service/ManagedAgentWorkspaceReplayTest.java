package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedAgentWorkspaceReplayTest {

    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedWorkspaceRegistry registry;
    private ManagedAgentStore store;
    private ManagedAgentProperties properties;

    private ManagedAgentService service(AtomicBoolean files) {
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return files.get();
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        return new Attachment("boot");
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        return new ManagedAgentService(store, new RequestDigests(),
                mock(HarnessCoordinator.class), harness, registry);
    }

    private String boundSession(String tenant) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, "ws-a", "storage-a", "ws-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, "ws-a",
                "actor-a".getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)",
                tenant, "ws-a",
                "actor-b".getBytes(StandardCharsets.UTF_8));
        return transaction.execute(status -> store
                .insertWorkspaceSessionCommand(tenant, "actor-a", "create",
                        "sha256:" + "a".repeat(64), "qwen-code", null, null,
                        List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId());
    }

    private void freshDatabase() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:workspace-replay-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                + ";LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        transaction = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        registry = new ManagedWorkspaceRegistry(jdbc);
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), events -> { }, registry, properties);
    }

    // The recorded submit must answer through a Workspace-files outage, like
    // the recorded create does: the availability gate waits below the replay,
    // while the actor gate stays above it.
    @Test
    void aRecordedSubmitAnswersThroughAWorkspaceFilesOutage() {
        freshDatabase();
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        AtomicBoolean files = new AtomicBoolean(true);
        ManagedAgentService service = service(files);
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", sessionId,
                        input).replayed()).isFalse());

        files.set(false);
        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", sessionId,
                        input).replayed()).isTrue());
        // The outage changes nothing about who the recorded outcome answers
        // to...
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-b",
                        "submit", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        // ...and a fresh key keeps the honest refusal.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-a",
                        "submit-fresh", sessionId, input))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
    }

    // A delete-tolerant rename replay shows the Session as last visible, but
    // the capabilities must describe the tombstone: artifact reads on a
    // deleted Session answer 404, so capabilities.artifacts must be false
    // even while the artifact feature is enabled.
    @Test
    void aDeletedBoundSessionReplaysItsRenameWithoutAdvertisingArtifacts() {
        freshDatabase();
        properties.getArtifacts().setEnabled(true);
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = service(new AtomicBoolean(true));
        ManagedArtifactReader reader = mock(ManagedArtifactReader.class);
        when(reader.supported()).thenReturn(true);
        service.configureArtifacts(properties, reader);

        transaction.executeWithoutResult(status -> {
            var renamed = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(renamed.replayed()).isFalse();
            // The capability is live before the delete, so its absence in
            // the replay is measured rather than defaulted.
            assertThat(renamed.body().capabilities().artifacts()).isTrue();
        });

        // The delete flow's durable footprint: the command row records the
        // last-visible status, and the Session row becomes a tombstone.
        jdbc.update("INSERT INTO managed_agent_command (tenant_id,"
                        + " operation, idempotency_key, request_digest,"
                        + " session_id, turn_id, command_status,"
                        + " session_status_before, created_at, updated_at)"
                        + " VALUES (?, 'DELETE_SESSION', 'delete',"
                        + " 'delete-digest', ?, NULL, 'COMPLETED', 'ACTIVE',"
                        + " 0, 0)",
                tenant, sessionId);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED',"
                        + " deleted_at = 1, updated_at = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);

        transaction.executeWithoutResult(status -> {
            var replay = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.body().status()).isEqualTo("active");
            assertThat(replay.body().capabilities().artifacts()).isFalse();
        });
    }
}
