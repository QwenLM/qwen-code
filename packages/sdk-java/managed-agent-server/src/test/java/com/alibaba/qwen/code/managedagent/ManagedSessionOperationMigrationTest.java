package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.LegacyLifecycleCommands.Sessions;
import com.alibaba.qwen.code.managedagent.ManagedAgentServerIntegrationTest.FixtureHarness;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleCoordinator;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleService;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Upgrades an archive and a delete that waited for a retry before V17 on H2
 * in MySQL mode and finishes them; ManagedAgentMySqlIT runs the same upgrade
 * on MySQL.
 */
class ManagedSessionOperationMigrationTest {
    private static final String TENANT = "legacy-tenant";

    @Test
    void finishesLifecycleCommandsThatWaitedBeforeTheUpgrade() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:session-operation-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("15")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        Sessions sessions = LegacyLifecycleCommands.insert(jdbc, TENANT);

        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();

        List<String> operations = LegacyLifecycleCommands.assertMigrated(
                jdbc, TENANT, sessions);
        FixtureHarness harness = new FixtureHarness();
        ManagedAgentProperties properties = new ManagedAgentProperties();
        ManagedWorkspaceRegistry registry = new ManagedWorkspaceRegistry(jdbc);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, registry, properties);
        RequestDigests digests = new RequestDigests();
        try (ExecutorService executor =
                Executors.newVirtualThreadPerTaskExecutor()) {
            SessionLifecycleCoordinator coordinator =
                    new SessionLifecycleCoordinator(store,
                            new ManagedSessionStore(jdbc), harness,
                            new DrainedRuntime(), executor, Clock.systemUTC(),
                            properties);
            SessionLifecycleService lifecycle = new SessionLifecycleService(
                    store, new ManagedAgentService(store, digests, null,
                            harness, registry), digests, coordinator);

            // A retry of the original key replays the migrated operation.
            PublicCommandOperation archive = lifecycle.admitPublic(TENANT,
                    null, "archive", sessions.archiving(),
                    OperationKind.ARCHIVE);
            assertThat(archive.id()).isEqualTo(operations.get(0));
            assertThat(archive.replayed()).isTrue();
            // The worker finds the other one on its own.
            coordinator.recoverOperations();
            await().atMost(Duration.ofSeconds(5)).until(() ->
                    "ARCHIVED".equals(store.requireSession(TENANT,
                            sessions.archiving()).status())
                            && "DELETED".equals(store.requireSession(TENANT,
                                    sessions.deleting()).status()));
            assertThat(((PublicCommandOperation) lifecycle.getPublicOperation(
                    TENANT, null, sessions.archiving(), archive.id()))
                    .admissionStage()).isEqualTo("harness_confirmed");
            assertThat(((PublicCommandOperation) lifecycle.getPublicOperation(
                    TENANT, null, sessions.deleting(), operations.get(1)))
                    .admissionStage()).isEqualTo("java_durable");
            // The archive was admitted on an active Session, so it closes it
            // as archive did before; the delete of an archived one does not.
            assertThat(harness.closeCount()).isEqualTo(1);
        }
    }

    private static final class DrainedRuntime implements RuntimeWarmer {
        @Override
        public boolean isEnabled() {
            return false;
        }

        @Override
        public CompletionStage<Void> warm(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> drain(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }
    }
}
