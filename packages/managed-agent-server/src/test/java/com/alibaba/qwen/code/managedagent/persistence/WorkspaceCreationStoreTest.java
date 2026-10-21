package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

class WorkspaceCreationStoreTest {
    @TempDir
    Path temp;
    protected JdbcTemplate jdbc;
    protected DataSource source;
    protected ManagedAgentProperties properties;
    protected WorkspaceStorageGuard guard;
    protected ManagedWorkspaceRegistry registry;

    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:create-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setWorkspaceCreationRoot(Files.createDirectory(temp.resolve("created")).toRealPath().toString());
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        registry = new ManagedWorkspaceRegistry(jdbc);
        guard = new WorkspaceStorageGuard(jdbc, new DataSourceTransactionManager(source), properties,
                path -> new WorkspaceStorageGuard.Identity(path.toString(), "test-host", "device",
                        Files.readAttributes(path, BasicFileAttributes.class).fileKey().toString(),
                        "2026-10-15T00:00:00.123456789Z"));
    }

    protected WorkspaceCreationStore store(WorkspaceStorageGuard storage) {
        return new WorkspaceCreationStore(jdbc, new DataSourceTransactionManager(source), storage,
                registry, properties, new ObjectMapper(), Clock.systemUTC());
    }

    @Test
    void createsSeparateRegisteredRootsAndSurvivesRestart() throws Exception {
        var first = store(guard).create("tenant", "actor", "  First  ", "one");
        var second = store(guard).create("tenant", "actor", "Second", "two");
        assertThat(first.displayName()).isEqualTo("First");
        assertThat(first.canCreateSession()).isTrue();
        assertThat(jdbc.queryForList("SELECT result_json FROM ma_request_receipt", String.class))
                .allSatisfy(value -> assertThat(value).doesNotContain("\"localRoot\""));
        assertThat(second.workspaceId()).isNotEqualTo(first.workspaceId());
        assertThat(registry.findReadable("tenant", "other", first.workspaceId())).isNull();
        assertThat(registry.findReadable("other", "actor", first.workspaceId())).isNull();
        String storage = storage(first.workspaceId());
        Path root = guard.createdStorageRoot("tenant", storage);
        assertThat(root).startsWith(Path.of(properties.getRuntimeBroker().getWorkspaceCreationRoot()));
        assertThat(Files.exists(root.resolve(".qwen-managed-storage.json"))).isTrue();
        assertThat(guard.inspect("tenant", storage)).contains("state=ready", "identity=match", "marker=match");
        Files.writeString(root.resolve("kept.txt"), "durable");
        assertThat(store(guard).create("tenant", "actor", "First", "one")).isEqualTo(first);
        assertThat(Files.readString(new WorkspaceCreationRoots(jdbc, properties)
                .resolve("tenant", storage, false).resolve("kept.txt"))).isEqualTo("durable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE is_default", Integer.class)).isZero();
        guard.verify(binding(first.workspaceId()));
        jdbc.update("UPDATE ma_workspace SET state = 'REMOVED' WHERE workspace_id = ?", first.workspaceId());
        assertThat(guard.createdStorageRoot("tenant", storage)).isEqualTo(root);
    }

    @Test
    void uncertainRegistrationResumesSameRootAndOperation() {
        var interrupted = spy(guard);
        doAnswer(call -> {
            call.callRealMethod();
            throw new IllegalStateException("lost response after registration");
        }).when(interrupted).registerCreated(anyString(), anyString(), anyString());
        assertThatThrownBy(() -> store(interrupted).create("tenant", "actor", "Retry", "retry"))
                .isInstanceOf(IllegalStateException.class);
        var before = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        var receipt = jdbc.queryForMap("SELECT * FROM ma_request_receipt");
        assertThat(receipt.get("state")).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
        String storage = "created-" + receipt.get("receipt_key");
        assertThat(guard.createdStorageRoot("tenant", storage)).isNull();
        var created = store(guard).create("tenant", "actor", "Retry", "retry");
        assertThat(storage(created.workspaceId())).isEqualTo(storage);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(before);
    }

    @Test
    void replayDoesNotRestoreRevokedAccessOrReRegisterHeldStorage() {
        var created = store(guard).create("tenant", "actor", "Held", "held");
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'already-held'");
        assertThat(store(guard).create("tenant", "actor", "Held", "held")).isEqualTo(created);
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Different", "held"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        jdbc.update("DELETE FROM ma_workspace_access");
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Held", "held"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        jdbc.update("DELETE FROM ma_workspace");
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Held", "held")).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
    }

    @Test
    void concurrentSameKeyCreatesOneWorkspace() throws Exception {
        var barrier = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var tasks = List.of(
                    pool.submit(() -> {
                        barrier.await();
                        return store(guard).create("tenant", "actor", "Concurrent", "same");
                    }),
                    pool.submit(() -> {
                        barrier.await();
                        return store(guard).create("tenant", "actor", "Concurrent", "same");
                    }));
            assertThat(tasks.get(0).get(20, TimeUnit.SECONDS)).isEqualTo(tasks.get(1).get(20, TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    @Test
    void validatesNamesAndDisabledConfiguration() {
        for (String name : List.of(" ", "a\nb", "x".repeat(129))) {
            assertThatThrownBy(() -> store(guard).create("tenant", "actor", name, UUID.randomUUID().toString()))
                    .isInstanceOf(ManagedAgentException.class);
        }
        properties.getRuntimeBroker().setWorkspaceCreationRoot("");
        assertThat(store(guard).enabled()).isFalse();
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Name", "key")).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isZero();
    }

    @Test
    void refusesSymlinkAndReplacedRootsAndUnbackedStorage() throws Exception {
        assertThat(guard.createdStorageRoot("tenant", "created-" + "a".repeat(64))).isNull();
        var created = store(guard).create("tenant", "actor", "Root", "root");
        Path root = guard.createdStorageRoot("tenant", storage(created.workspaceId()));
        Path moved = root.resolveSibling("moved");
        Files.move(root, moved);
        Files.createSymbolicLink(root, moved);
        assertThatThrownBy(() -> guard.createdStorageRoot("tenant", storage(created.workspaceId()))).isInstanceOf(RuntimeException.class);
        Files.delete(root);
        Files.createDirectory(root);
        Files.copy(moved.resolve(".qwen-managed-storage.json"), root.resolve(".qwen-managed-storage.json"));
        assertThatThrownBy(() -> guard.verify(binding(created.workspaceId()))).isInstanceOf(RuntimeException.class);
    }

    @Test
    void initialToolTurnAdmitsCompletedDynamicStorage() {
        var created = store(guard).create("tenant", "actor", "Tools", "tools");
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var sessions = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                ignored -> {}, registry, properties);
        var admitted = new TransactionTemplate(new DataSourceTransactionManager(source)).execute(status ->
                sessions.insertWorkspaceSessionCommand("tenant", "actor", "session-key", "digest",
                        "qwen-code", null, null, List.of(java.util.Map.of("type", "input_text", "text", "Read a file")),
                        "payload-digest", new WorkspaceSelection(created.workspaceId(), ".")));
        assertThat(admitted.sessionId()).isNotBlank();
    }

    @Test
    void refusesOverlappingPrivateRootsAndMalformedReceipt() throws Exception {
        Path base = Path.of(properties.getRuntimeBroker().getWorkspaceCreationRoot());
        properties.getRuntimeBroker().setStateDirectory(base.resolve("private").toString());
        assertThatThrownBy(() -> new WorkspaceCreationRoots(jdbc, properties)).isInstanceOf(IllegalStateException.class);
        properties.getRuntimeBroker().setStateDirectory("");
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "alias", base.toString())));
        assertThatThrownBy(() -> new WorkspaceCreationRoots(jdbc, properties)).isInstanceOf(IllegalStateException.class);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of());
        var created = store(guard).create("tenant", "actor", "Intact", "intact");
        String storage = storage(created.workspaceId());
        jdbc.update("UPDATE ma_request_receipt SET result_json = '{}' WHERE namespace = 'WORKSPACE_CREATE'");
        assertThatThrownBy(() -> guard.createdStorageRoot("tenant", storage)).isInstanceOf(RuntimeException.class);
    }

    private String storage(String workspace) {
        return jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE workspace_id = ?", String.class, workspace);
    }

    @Test
    void selectsExistingProjectAndPersistsItsDefaultWithoutRegisteringStorageAgain() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "projects");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        Path project = Files.createDirectory(root.resolve("existing-project"));
        Files.writeString(project.resolve("README.md"), "existing project");
        var before = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'existing-runtime'");
        var created = store(guard).create("tenant", "actor", "Project", "selected",
                parent.workspaceId(), "./existing-project/");
        assertThat(created.defaultCwdRelative()).isEqualTo("existing-project");
        assertThat(storage(created.workspaceId())).isEqualTo(storage(parent.workspaceId()));
        assertThat(Files.readString(project.resolve("README.md"))).isEqualTo("existing project");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).containsEntry("holder_key", "existing-runtime")
                .containsEntry("mount_registration_id", before.get("mount_registration_id"));
        assertThat(new ManagedWorkspaceRegistry(jdbc).findReadable("tenant", "actor", created.workspaceId())
                .defaultCwdRelative()).isEqualTo("existing-project");
        assertThat(store(guard).create("tenant", "actor", "Project", "selected", parent.workspaceId(),
                "existing-project")).isEqualTo(created);
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Project", "selected",
                parent.workspaceId(), ".")).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        jdbc.update("DELETE FROM ma_workspace_access WHERE workspace_id = ?", parent.workspaceId());
        assertThat(store(guard).create("tenant", "actor", "Project", "selected", parent.workspaceId(),
                "existing-project")).isEqualTo(created);
        jdbc.update("DELETE FROM ma_workspace_access WHERE workspace_id = ?", created.workspaceId());
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Project", "selected",
                parent.workspaceId(), "existing-project")).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void browsesOnlyOwnedRealDirectoriesAndRefusesUnsafeSelections() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "browse");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        Files.createDirectory(root.resolve("project"));
        Files.createDirectory(root.resolve(".git"));
        Files.createDirectory(root.resolve(".qwen-child-workspaces"));
        Files.createSymbolicLink(root.resolve("outside"), temp);
        var page = store(guard).directories("tenant", "actor", parent.workspaceId(), ".");
        assertThat(page.root()).isEqualTo(root.toString());
        assertThat(page.directories()).extracting(WorkspaceCreationStore.Directory::name).containsExactly("project");
        for (String path : List.of("../", "outside", ".git", ".qwen-child-workspaces")) {
            String code = "outside".equals(path) ? "workspace_unavailable" : "invalid_cwd";
            assertThatThrownBy(() -> store(guard).directories("tenant", "actor", parent.workspaceId(), path))
                    .isInstanceOfAny(ManagedAgentException.class, RuntimeBrokerException.class)
                    .hasFieldOrPropertyWithValue("code", code);
            assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Unsafe", "unsafe-" + path,
                    parent.workspaceId(), path)).isInstanceOfAny(ManagedAgentException.class, RuntimeBrokerException.class)
                    .hasFieldOrPropertyWithValue("code", code);
        }
        assertThatThrownBy(() -> store(guard).directories("other", "actor", parent.workspaceId(), "."))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> store(guard).directories("tenant", "other", parent.workspaceId(), "."))
                .isInstanceOf(ManagedAgentException.class);
        for (String role : List.of("READER", "OPERATOR")) {
            jdbc.update("UPDATE ma_workspace_access SET role = ?", role);
            assertThatThrownBy(() -> store(guard).directories("tenant", "actor", parent.workspaceId(), "."))
                    .isInstanceOf(ManagedAgentException.class);
            assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Refused", "role-" + role,
                    parent.workspaceId(), "project")).isInstanceOf(ManagedAgentException.class);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
    }

    @Test
    void truncatesOnlyWhenAnotherEligibleDirectoryRemains() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "directory-limit");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        for (int index = 0; index < 100; index++) {
            Files.createDirectory(root.resolve("project-" + index));
            Files.writeString(root.resolve("ignored-" + index), "not a directory");
        }
        var complete = store(guard).directories("tenant", "actor", parent.workspaceId(), ".");
        assertThat(complete.directories()).hasSize(100);
        assertThat(complete.truncated()).isFalse();
        Files.createDirectory(root.resolve("one-more-project"));
        var limited = store(guard).directories("tenant", "actor", parent.workspaceId(), ".");
        assertThat(limited.directories()).hasSize(100);
        assertThat(limited.truncated()).isTrue();
    }

    @Test
    void preservesTheRawEntryScanBudgetWhenEntriesAreFilteredOut() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "directory-scan-limit");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        for (int index = 0; index < 1025; index++) {
            Files.writeString(root.resolve("ignored-" + index), "not a directory");
        }
        var page = store(guard).directories("tenant", "actor", parent.workspaceId(), ".");
        assertThat(page.directories()).isEmpty();
        assertThat(page.truncated()).isTrue();
    }

    @Test
    void localDirectorySelectionRefusesRemoteStorageEvenIfGeneralVerificationSucceeds() {
        var parent = store(guard).create("tenant", "actor", "Projects", "remote-parent");
        assertThat(parent.canSelectDirectory()).isTrue();
        jdbc.update("UPDATE ma_storage SET storage_kind = 'SSH_LOCAL' WHERE alias_key = ?",
                WorkspaceCsiRegistration.aliasKey("tenant", storage(parent.workspaceId())));
        assertThat(registry.findReadable("tenant", "actor", parent.workspaceId()).canSelectDirectory()).isFalse();
        assertThat(registry.listReadable("tenant", "actor", null, 10))
                .allSatisfy(item -> assertThat(item.canSelectDirectory()).isFalse());
        var remoteAware = spy(guard);
        org.mockito.Mockito.doNothing().when(remoteAware).verify(org.mockito.ArgumentMatchers.any());
        assertThatThrownBy(() -> remoteAware.verifiedRoot(binding(parent.workspaceId())))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store(guard).directories("tenant", "actor", parent.workspaceId(), "."))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Remote", "remote-selection",
                parent.workspaceId(), ".")).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
    }

    @Test
    void pendingSelectionCannotRebindAfterSourceGenerationChanges() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "pending-parent");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        Files.createDirectory(root.resolve("project"));
        var interrupted = spy(guard);
        var count = new java.util.concurrent.atomic.AtomicInteger();
        doAnswer(invocation -> {
            if (count.incrementAndGet() == 2) {
                throw new IllegalStateException("interrupted after receipt");
            }
            return invocation.callRealMethod();
        }).when(interrupted).verifiedRoot(org.mockito.ArgumentMatchers.any());
        assertThatThrownBy(() -> store(interrupted).create("tenant", "actor", "Project", "pending-selection",
                parent.workspaceId(), "project")).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE state = 'PENDING'", Integer.class))
                .isEqualTo(1);
        jdbc.update("UPDATE ma_workspace SET workspace_generation = 2 WHERE workspace_id = ?", parent.workspaceId());
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Project", "pending-selection",
                parent.workspaceId(), "project")).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
    }

    @Test
    void concurrentSelectionPublishesOneWorkspace() throws Exception {
        var parent = store(guard).create("tenant", "actor", "Projects", "concurrent-parent");
        Path root = guard.createdStorageRoot("tenant", storage(parent.workspaceId()));
        Files.createDirectory(root.resolve("project"));
        var barrier = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            java.util.concurrent.Callable<ManagedWorkspaceRegistry.WorkspaceSummary> action = () -> {
                barrier.await();
                return store(guard).create("tenant", "actor", "Project", "concurrent-project",
                        parent.workspaceId(), "project");
            };
            var first = pool.submit(action);
            var second = pool.submit(action);
            assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo(second.get(20, TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    private Path localProject(String name) throws Exception {
        properties.getRuntimeBroker().setLocalDirectoryImportEnabled(true);
        Path projects = temp.resolve("projects");
        Files.createDirectories(projects);
        Path project = Files.createDirectory(projects.resolve(name));
        Files.createDirectory(project.resolve(".git"));
        Files.writeString(project.resolve("README.md"), "existing content");
        return project.toRealPath();
    }

    private ManagedWorkspaceRegistry.WorkspaceSummary importProject(Path project, String key) {
        return store(guard).create("tenant", "actor", project.getFileName().toString(), key, null, null, project.toString());
    }

    @Test
    void importsAnExistingProjectWithoutRegisteredParentAndResolvesAfterRestart() throws Exception {
        Path project = localProject("first");
        properties.getRuntimeBroker().setWorkspaceCreationRoot("");
        var created = importProject(project, "import");
        assertThat(created.defaultCwdRelative()).isEqualTo("first");
        assertThat(created.canSelectDirectory()).isTrue();
        assertThat(registry.accessOf("tenant", "actor", created.workspaceId()).name()).isEqualTo("OWNER");
        assertThat(registry.findReadable("tenant", "other", created.workspaceId())).isNull();
        assertThat(guard.createdStorageRoot("tenant", storage(created.workspaceId()))).isEqualTo(project.getParent());
        assertThat(Files.readString(project.resolve("README.md"))).isEqualTo("existing content");
        assertThat(Files.exists(project.resolve(".qwen-managed-storage.json"))).isFalse();
        assertThat(Files.exists(project.getParent().resolve(".qwen-managed-storage.json"))).isTrue();
        properties.getRuntimeBroker().setLocalDirectoryImportEnabled(false);
        assertThat(new WorkspaceCreationRoots(jdbc, properties).resolve("tenant", storage(created.workspaceId()), false))
                .isEqualTo(project.getParent());
        guard.verify(new ContextBinding("tenant", created.workspaceId(), 1, storage(created.workspaceId()), "first", "config", 1));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var sessions = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {}, registry, properties);
        var admitted = new TransactionTemplate(new DataSourceTransactionManager(source)).execute(status ->
                sessions.insertWorkspaceSessionCommand("tenant", "actor", "local-session", "digest", "qwen-code", null, null,
                        List.of(java.util.Map.of("type", "input_text", "text", "Read README.md")), "payload-digest",
                        new WorkspaceSelection(created.workspaceId(), created.defaultCwdRelative())));
        assertThat(admitted.sessionId()).isNotBlank();
    }

    @Test
    void importsASecondProjectWithoutRegisteringHeldParentAgain() throws Exception {
        Path first = localProject("first");
        Path second = localProject("second");
        var original = importProject(first, "first");
        var before = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'running-runtime'");
        var next = importProject(second, "second");
        assertThat(next.defaultCwdRelative()).isEqualTo("second");
        assertThat(storage(next.workspaceId())).isEqualTo(storage(original.workspaceId()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).containsEntry("holder_key", "running-runtime")
                .containsEntry("mount_registration_id", before.get("mount_registration_id"));
    }

    @Test
    void importedRequestReplayFreezesPathAndNeverRestoresRevokedAccess() throws Exception {
        Path first = localProject("first");
        Path second = localProject("second");
        var created = importProject(first, "same");
        assertThat(importProject(first, "same")).isEqualTo(created);
        assertThatThrownBy(() -> importProject(second, "same")).hasFieldOrPropertyWithValue("code", "idempotency_conflict");
        jdbc.update("DELETE FROM ma_workspace_access");
        assertThatThrownBy(() -> importProject(first, "same")).hasFieldOrPropertyWithValue("code", "workspace_not_found");
        assertThatThrownBy(() -> importProject(first, "new")).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
    }

    @Test
    void refusesDisabledImportAndMixedRequestsBeforeCreatingReceipts() throws Exception {
        Path project = localProject("project");
        properties.getRuntimeBroker().setLocalDirectoryImportEnabled(false);
        assertThatThrownBy(() -> importProject(project, "disabled"))
                .hasFieldOrPropertyWithValue("code", "workspace_creation_unavailable");
        properties.getRuntimeBroker().setLocalDirectoryImportEnabled(true);
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Mixed", "mixed", "source", ".", project.toString()))
                .hasFieldOrPropertyWithValue("code", "invalid_request");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isZero();
    }

    @Test
    void refusesPrivateSymlinkMissingAndForeignDirectoriesWithoutGrantingAccess() throws Exception {
        Path project = localProject("project");
        Path privateState = Files.createDirectory(project.getParent().resolve("private-state"));
        properties.getRuntimeBroker().setStateDirectory(privateState.toString());
        assertThatThrownBy(() -> importProject(project, "overlap")).hasFieldOrPropertyWithValue("code", "invalid_local_directory");
        assertThatThrownBy(() -> store(guard).localDirectories(privateState.toString()))
                .hasFieldOrPropertyWithValue("code", "invalid_local_directory");
        assertThat(store(guard).localDirectories(project.getParent().toString()).directories())
                .extracting(WorkspaceCreationStore.Directory::name).containsExactly("project");
        properties.getRuntimeBroker().setStateDirectory("");
        Path link = Files.createSymbolicLink(project.getParent().resolve("link"), project);
        for (String path : List.of("relative", link.toString(), project.resolve("missing").toString(),
                project.resolve(".git").toString())) {
            assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Invalid", "bad-" + UUID.randomUUID(), null, null, path))
                    .hasFieldOrPropertyWithValue("code", "invalid_local_directory");
        }
        Files.writeString(project.getParent().resolve(".qwen-managed-storage.json"), "foreign marker");
        assertThatThrownBy(() -> importProject(project, "foreign")).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
    }

    @Test
    void pendingImportPinsPhysicalIdentityAndDoesNotRegisterReplacementRoot() throws Exception {
        Path project = localProject("project");
        var interrupted = spy(guard);
        org.mockito.Mockito.doThrow(new IllegalStateException("interrupted before registration"))
                .when(interrupted).registerCreated(anyString(), anyString(), anyString());
        assertThatThrownBy(() -> store(interrupted).create("tenant", "actor", "project", "pending", null, null, project.toString()))
                .isInstanceOf(IllegalStateException.class);
        Files.move(project.getParent(), temp.resolve("old-projects"));
        Files.createDirectories(project);
        assertThatThrownBy(() -> importProject(project, "pending")).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isZero();
        assertThat(Files.exists(project.getParent().resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void pendingImportCanReuseAnotherCompletedImportOfItsPinnedParent() throws Exception {
        Path first = localProject("first");
        Path second = localProject("second");
        var interrupted = spy(guard);
        org.mockito.Mockito.doThrow(new IllegalStateException("interrupted before registration"))
                .when(interrupted).registerCreated(anyString(), anyString(), anyString());
        assertThatThrownBy(() -> store(interrupted).create("tenant", "actor", "first", "pending", null, null, first.toString()))
                .isInstanceOf(IllegalStateException.class);
        var completed = importProject(second, "completed");
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'running-runtime'");
        var retried = importProject(first, "pending");
        assertThat(storage(retried.workspaceId())).isEqualTo(storage(completed.workspaceId()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        assertThat(retried.defaultCwdRelative()).isEqualTo("first");
    }

    @Test
    void concurrentImportsOfTheSameRequestPublishOneWorkspace() throws Exception {
        Path project = localProject("project");
        var barrier = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            java.util.concurrent.Callable<ManagedWorkspaceRegistry.WorkspaceSummary> action = () -> {
                barrier.await();
                return importProject(project, "concurrent-import");
            };
            var first = pool.submit(action);
            var second = pool.submit(action);
            assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo(second.get(20, TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    @Test
    void unrelatedMissingImportedRootDoesNotBlockAnotherImport() throws Exception {
        Path first = localProject("first");
        importProject(first, "first");
        Files.move(first.getParent(), temp.resolve("archived-projects"));
        Path other = Files.createDirectories(temp.resolve("other-projects/second")).toRealPath();
        assertThat(importProject(other, "second").defaultCwdRelative()).isEqualTo("second");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(2);
    }

    @Test
    void pendingAndCompletedImportsRecheckPrivateStateAfterConfigurationChanges() throws Exception {
        Path project = localProject("project");
        var interrupted = spy(guard);
        org.mockito.Mockito.doThrow(new IllegalStateException("interrupted before registration"))
                .when(interrupted).registerCreated(anyString(), anyString(), anyString());
        assertThatThrownBy(() -> store(interrupted).create("tenant", "actor", "project", "pending-private", null, null,
                project.toString())).isInstanceOf(IllegalStateException.class);
        properties.getRuntimeBroker().setStateDirectory(project.getParent().resolve("private-runtime").toString());
        assertThatThrownBy(() -> importProject(project, "pending-private"))
                .hasFieldOrPropertyWithValue("code", "invalid_local_directory");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isZero();
        properties.getRuntimeBroker().setStateDirectory("");
        var created = importProject(project, "pending-private");
        properties.getRuntimeBroker().setStateDirectory(project.getParent().resolve("private-runtime").toString());
        assertThatThrownBy(() -> new WorkspaceCreationRoots(jdbc, properties).resolve("tenant", storage(created.workspaceId()), false))
                .hasFieldOrPropertyWithValue("code", "workspace_unavailable");
    }

    private ContextBinding binding(String workspace) {
        return new ContextBinding("tenant", workspace, 1, storage(workspace), ".", "config", 1);
    }
}
