package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The W2 execution pivot: after a cwd change commits, the exact resolution
 * a tool turn performs must answer with the committed binding, so the next
 * acquisition installs the new context on a fresh Runtime Session and never
 * the prior directory.
 */
class WorkspaceRuntimeResolutionPivotTest {
    private static final String TENANT = "pivot-tenant";
    private static final String ACTOR = "actor-a";
    private static final String WS = "ws-a";
    private static final String STORAGE = "storage-a";

    @TempDir
    private Path temporary;

    @Test
    void aCommittedChangeIsWhatTheNextTurnResolves() throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("services/api"));
        Files.createDirectories(root.resolve("services/b"));
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:pivot-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setIsolationClass("session");
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        TENANT, STORAGE, root.toString())));
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc), properties);
        WorkspaceRuntimeResolver resolver = new WorkspaceRuntimeResolver(
                store, new WorkspaceExecutionStore(jdbc,
                        new DataSourceTransactionManager(dataSource)),
                properties);

        String sessionId = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource))
                .execute(status -> {
                    jdbc.update("INSERT INTO managed_workspace_registry"
                            + " (tenant_id, workspace_id,"
                            + " workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref,"
                            + " state) VALUES (?, ?, 1, ?, ?, ?, ?,"
                            + " 'ACTIVE')", TENANT, WS, STORAGE, WS,
                            WorkspaceExecutionProfile.CONFIG_REF,
                            WorkspaceExecutionProfile.POLICY_REF);
                    jdbc.update("INSERT INTO managed_workspace_access"
                            + " (tenant_id, workspace_id, actor_id,"
                            + " can_read, can_create) VALUES (?, ?, ?,"
                            + " TRUE, TRUE)", TENANT, WS,
                            ACTOR.getBytes(java.nio.charset
                                    .StandardCharsets.UTF_8));
                    return store.insertWorkspaceSessionCommand(TENANT, ACTOR,
                            "create", "digest", "qwen-code", null, null,
                            List.of(), null,
                            new WorkspaceSelection(WS, "services/api"))
                            .sessionId();
                });

        ContextBinding before = resolver.resolve(sessionId).binding();
        assertThat(before.getCwdRelative()).isEqualTo("services/api");
        assertThat(before.getContextRevision()).isEqualTo(1);

        OperationRecord admitted = store.beginCwdChangeOperation(TENANT,
                sessionId, ACTOR, "digest-of-actor-a", "cwd-1",
                "cwd-digest", "services/b", 1).operation();
        OperationRecord claimed = store.claimOperation(TENANT, sessionId,
                admitted.operationId(), "owner", Duration.ofMillis(6000))
                .orElseThrow();
        var outcome = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource))
                .execute(status -> store.completeCwdChangeOperation(TENANT,
                        sessionId, admitted.operationId(), "owner",
                        claimed.claimGeneration()));
        assertThat(outcome.completed()).isTrue();

        ContextBinding pivoted = resolver.resolve(sessionId).binding();
        assertThat(pivoted.getCwdRelative()).isEqualTo("services/b");
        assertThat(pivoted.getContextRevision()).isEqualTo(2);
        assertThat(resolver.resolve(sessionId).scope().getCanonicalCwd())
                .isEqualTo(root.toString());
    }
}
