package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
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
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        jdbc.update("DELETE FROM ma_workspace_access");
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Held", "held"))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_not_found"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        jdbc.update("DELETE FROM ma_workspace");
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Held", "held")).isInstanceOf(ApiException.class);
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
                    .isInstanceOf(ApiException.class);
        }
        properties.getRuntimeBroker().setWorkspaceCreationRoot("");
        assertThat(store(guard).enabled()).isFalse();
        assertThatThrownBy(() -> store(guard).create("tenant", "actor", "Name", "key")).isInstanceOf(ApiException.class);
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

    private ContextBinding binding(String workspace) {
        return new ContextBinding("tenant", workspace, 1, storage(workspace), ".", "config", 1);
    }
}
