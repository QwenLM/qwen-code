package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles;
import com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionWorktreeStoreTest {
    @TempDir
    Path temp;
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private SessionWorktreeStore store;
    private String workspace;

    protected DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:session-worktree-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setup() throws Exception {
        DataSource source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve("created")).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        var registry = new ManagedWorkspaceRegistry(jdbc);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties,
                path -> new StorageIdentityReader.Identity(path.toString(), "test-host", "1", "2", "2026-10-15T00:00:00.123456789Z"));
        workspace = new WorkspaceCreationStore(jdbc, manager, guard, registry, properties, new ObjectMapper(), Clock.systemUTC())
                .create("tenant", "actor", "Worktrees", "create").workspaceId();
        store = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new SessionWorktreeStore(jdbc, registry, guard));
    }

    @Test
    void usesManagedJdbcWhenTheHostProvidesDefaultPersistenceBeans() {
        var host = new DriverManagerDataSource("jdbc:h2:mem:host-" + UUID.randomUUID(), "sa", "");
        new ApplicationContextRunner().withUserConfiguration(SessionWorktreeStore.class)
                .withBean("managedJdbcTemplate", JdbcTemplate.class, () -> jdbc, definition -> ((org.springframework.beans.factory.support.AbstractBeanDefinition) definition).setDefaultCandidate(false))
                .withBean("hostJdbcTemplate", JdbcTemplate.class, () -> new JdbcTemplate(host))
                .withBean("hostTransactionManager", org.springframework.transaction.PlatformTransactionManager.class,
                        () -> new DataSourceTransactionManager(host))
                .withBean(ManagedWorkspaceRegistry.class, () -> new ManagedWorkspaceRegistry(jdbc))
                .withBean(WorkspaceStorageGuard.class, () -> org.mockito.Mockito.mock(WorkspaceStorageGuard.class))
                .withBean(SshWorkspaceStore.class, () -> org.mockito.Mockito.mock(SshWorkspaceStore.class))
                .withBean(ManagedAgentProperties.class, ManagedAgentProperties::new)
                .withBean(WorktreeFiles.class, LocalWorktreeFiles::new)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(SessionWorktreeStore.class).describe("tenant", "missing")).isNull();
                });
    }

    @Test
    void durablePreparationClaimAndFilesystemIdentityGate() throws Exception {
        var location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "."));
        Path repository = Files.createDirectory(location.root().resolve("project"));
        git(repository, "init", "-b", "main");
        Files.writeString(repository.resolve("file.txt"), "base\n");
        git(repository, "add", ".");
        git(repository, "commit", "-m", "base");
        location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "project"));
        var binding = location.resolved().binding();
        try (var git = new SessionWorktreeGit(new ChildWorktreeGit("git", Duration.ofSeconds(10)))) {
            var source = git.source(location.root(), "project", null);
            String id = UUID.randomUUID().toString().replace("-", "");
            String cwd = SessionWorktreeGit.CONTAINER + "/" + id;
            Plan plan = new Plan("tenant", workspace, binding.getWorkspaceGeneration(), binding.getStorageId(), "project",
                    binding.getContextConfigRef(), 1, location.root().toString(), SessionWorktreeGit.identity(location.root()),
                    source.repositoryRelative(), source.offset(), source.commonDirectory(), source.commonIdentity(), null,
                    source.commit(), id, cwd, cwd, "worktree-managed-" + id);
            var resolved = location.resolved();
            transaction.executeWithoutResult(status -> {
                jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified) VALUES ('tenant','session','agent',1,1)");
                store.admit("tenant", "actor", "session", plan, resolved);
            });
            var sessions = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
            assertThat(sessions.listSessions("tenant", null, null, null, 1).worktrees().get("session").state())
                    .isEqualTo("preparing");
            assertThat(SessionWorktreeStore.isReady(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session")).isFalse();
            assertThat(store.due()).hasSize(1);
            var candidate = store.due().getFirst();
            SessionWorktreeStore.Row claim;
            try (var workers = java.util.concurrent.Executors.newFixedThreadPool(2)) {
                var start = new java.util.concurrent.CountDownLatch(1);
                var first = workers.submit(() -> {
                    start.await();
                    return store.claim(candidate, "first", 120000);
                });
                var second = workers.submit(() -> {
                    start.await();
                    return store.claim(candidate, "second", 120000);
                });
                start.countDown();
                var claims = java.util.Arrays.asList(first.get(10, java.util.concurrent.TimeUnit.SECONDS),
                        second.get(10, java.util.concurrent.TimeUnit.SECONDS));
                assertThat(claims).filteredOn(java.util.Objects::nonNull).hasSize(1);
                claim = claims.stream().filter(java.util.Objects::nonNull).findFirst().orElseThrow();
            }
            assertThat(claim).isNotNull();
            String physical = WorkspaceExecutionStore.storageKey(jdbc, com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.storageBinding(plan));
            jdbc.update("UPDATE ma_storage_owner SET holder_key = ?, maintenance_id = ?, maintenance_generation = ? WHERE storage_key = ?",
                    "live-step", claim.operationId(), claim.generation(), physical);
            assertThat(store.claim(claim, "other", 120000)).isNull();
            assertThat(store.describe("tenant", "session").state()).isEqualTo("preparing");
            jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL, maintenance_id = NULL, maintenance_generation = NULL WHERE storage_key = ?", physical);
            String identity = git.prepare(plan);
            assertThat(store.complete(claim, "foreign", "READY", identity, null)).isFalse();
            assertThat(store.complete(claim, claim.claimedBy(), "READY", identity, null)).isTrue();
            var ready = sessions.listSessions("tenant", null, null, null, 1).worktrees().get("session");
            assertThat(ready.id()).isEqualTo(id);
            assertThat(ready.state()).isEqualTo("ready");
            SessionWorktreeStore.requireReady(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session");
            assertThat(store.due()).isEmpty();
            assertThat(store.list("tenant", "actor", workspace)).hasSize(1);
            assertThatThrownBy(() -> SessionWorktreeStore.requireCwd(jdbc, "tenant", "session", "project"))
                    .hasMessageContaining("worktree_cwd_outside");
            Files.move(location.root().resolve(cwd), location.root().resolve(cwd + "-saved"));
            assertThatThrownBy(() -> transaction.execute(status -> {
                SessionWorktreeStore.requireReady(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session");
                return null;
            })).hasMessageContaining("worktree_identity_conflict");
            assertThat(sessions.listSessions("tenant", null, null, null, 1).worktrees().get("session").state())
                    .isEqualTo("blocked");
            assertThat(SessionWorktreeStore.descriptor(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session").state()).isEqualTo("blocked");
            assertThatThrownBy(() -> SessionWorktreeStore.requireReady(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(), jdbc, "tenant", "session"))
                    .hasMessageContaining("worktree_identity_conflict");
        }
    }

    @Test
    void cleanupReusesItsReceiptAndRemovesTheCheckoutUnderMaintenance() throws Exception {
        var location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "."));
        Path repository = Files.createDirectory(location.root().resolve("project"));
        git(repository, "init", "-b", "main");
        Files.writeString(repository.resolve("file.txt"), "base\n");
        git(repository, "add", ".");
        git(repository, "commit", "-m", "base");
        location = store.source("tenant", "actor", new WorkspaceSelection(workspace, "project"));
        var binding = location.resolved().binding();
        try (var git = new SessionWorktreeGit(new ChildWorktreeGit("git", Duration.ofSeconds(10)))) {
            var source = git.source(location.root(), "project", null);
            String id = UUID.randomUUID().toString().replace("-", "");
            String cwd = SessionWorktreeGit.CONTAINER + "/" + id;
            Plan plan = new Plan("tenant", workspace, binding.getWorkspaceGeneration(), binding.getStorageId(), "project",
                    binding.getContextConfigRef(), 1, location.root().toString(), SessionWorktreeGit.identity(location.root()),
                    source.repositoryRelative(), source.offset(), source.commonDirectory(), source.commonIdentity(), null,
                    source.commit(), id, cwd, cwd, "worktree-managed-" + id);
            var resolved = location.resolved();
            transaction.executeWithoutResult(status -> {
                jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified) VALUES ('tenant','cleanup-session','agent',1,1)");
                store.admit("tenant", "actor", "cleanup-session", plan, resolved);
            });
            var claim = store.claim(store.due().getFirst(), "prepare", 120000);
            assertThat(store.complete(claim, "prepare", "READY", git.prepare(plan), null)).isTrue();
            jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", "tenant", "cleanup-session");
            transaction.executeWithoutResult(status -> {
                store.cleanup("tenant", "actor", workspace, id, "rollback-removal");
                status.setRollbackOnly();
            });
            assertThat(store.describe("tenant", "cleanup-session").state()).isEqualTo("ready");
            var removal = store.cleanup("tenant", "actor", workspace, id, "remove");
            assertThat(store.cleanup("tenant", "actor", workspace, id, "remove").operationId()).isEqualTo(removal.operationId());
            var execution = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new WorkspaceExecutionStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource())));
            var service = VerificationFixtures.configure(new com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService(store, execution,
                    new ManagedAgentProperties(), org.mockito.Mockito.mock(ManagedAgentStore.class),
                    org.mockito.Mockito.mock(com.alibaba.qwen.code.managedagent.session.HarnessCoordinator.class)));
            try {
                service.drive(removal);
            } finally {
                org.springframework.test.util.ReflectionTestUtils.invokeMethod(service, "stop");
            }
            assertThat(store.describe("tenant", "cleanup-session").state())
                    .as("cleanup outcome: %s", store.describe("tenant", "cleanup-session")).isEqualTo("removed");
            assertThat(Files.exists(location.root().resolve(cwd))).isFalse();
            assertThat(store.cleanup("tenant", "actor", workspace, id, "remove").state()).isEqualTo("REMOVED");
        }
    }

    @Test
    void unsupportedOwnerCannotInspectOrAllocateAWorktree() {
        assertThatThrownBy(() -> store.source("tenant", "stranger", new WorkspaceSelection(workspace, ".")))
                .hasMessageContaining("Workspace not found");
        assertThatThrownBy(() -> store.list("tenant", "stranger", workspace)).hasMessageContaining("not found");
        assertThat(store.list("tenant", "actor", workspace)).isEmpty();
    }

    private static void git(Path directory, String... arguments) throws Exception {
        var command = new java.util.ArrayList<>(List.of("git", "-C", directory.toString(), "-c", "user.name=Test",
                "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null"));
        command.addAll(List.of(arguments));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        assertThat(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)).isZero();
    }
}
