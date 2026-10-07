package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;

class WorkspaceStorageGuardTest {
    @TempDir
    Path temp;
    private JdbcTemplate jdbc;
    private DriverManagerDataSource dataSource;
    private ManagedAgentProperties properties;
    private Path root;
    private ContextBinding binding;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = new DriverManagerDataSource("jdbc:h2:mem:w1-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(dataSource).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        root = Files.createDirectory(temp.resolve("root")).toRealPath();
        Files.createDirectory(root.resolve("child"));
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount("tenant", "storage", root.toString())));
        binding = new ContextBinding("tenant", "workspace", 1, "storage", "child",
                "config", 1);
    }

    @Test
    void requiresRegistrationAcrossInstancesAndRejectsReplacedRoot() throws Exception {
        WorkspaceStorageGuard first = guard();
        assertThat(first.inspect("tenant", "storage")).isEqualTo("unverified");
        assertUnavailable(() -> first.verify(binding));
        String operation = UUID.randomUUID().toString();
        first.register("tenant", "storage", operation);
        first.verify(binding);
        guard().verify(binding);
        assertThat(guard().inspect("tenant", "storage")).contains("state=ready revision=1", "holder=false identity=match marker=match");

        Path previous = temp.resolve("previous");
        Files.move(root, previous);
        Files.createDirectory(root);
        Files.createDirectory(root.resolve("child"));
        Files.copy(previous.resolve(".qwen-managed-storage.json"),
                root.resolve(".qwen-managed-storage.json"));
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("identity=mismatch");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
    }

    @Test
    void rejectsDeletedAndRestoredRootWhenInodeIsReusedButBirthTimeChanges() throws Exception {
        AtomicReference<String> birth = new AtomicReference<>("2026-09-30T00:00:00.123456789Z");
        WorkspaceStorageGuard.IdentityReader reader = path -> new WorkspaceStorageGuard.Identity(
                path.toString(), "test-host", "same-device", "reused-inode", birth.get());
        var manager = new DataSourceTransactionManager(dataSource);
        var original = new WorkspaceStorageGuard(jdbc, manager, properties, reader);
        String operation = UUID.randomUUID().toString();
        original.register("tenant", "storage", operation);
        original.verify(binding);
        Path marker = root.resolve(".qwen-managed-storage.json");
        byte[] backup = Files.readAllBytes(marker);
        var registration = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        Files.delete(marker);
        Files.delete(root.resolve("child"));
        Files.delete(root);
        Files.createDirectory(root);
        Files.createDirectory(root.resolve("child"));
        Files.write(marker, backup);
        birth.set("2026-09-30T00:00:00.123456790Z");
        var restarted = new WorkspaceStorageGuard(jdbc, manager, properties, reader);
        assertThat(restarted.inspect("tenant", "storage"))
                .contains("identity=mismatch", "marker=match");
        assertUnavailable(() -> restarted.verify(binding));
        assertUnavailable(() -> restarted.register("tenant", "storage", operation));
        assertUnavailable(() -> restarted.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease"))
                .isEqualTo(registration);
    }

    @Test
    void refusesMissingPersistedBirthTime() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        jdbc.update("UPDATE managed_workspace_execution_lease SET mount_birth_time = NULL");
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("identity=mismatch");
    }

    @Test
    void reportsUnreadableIdentityWithoutClaimingMismatch() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        var unavailable = new WorkspaceStorageGuard(jdbc,
                new DataSourceTransactionManager(dataSource), properties, path -> {
                    throw new IOException("identity is unreadable");
                });
        assertThat(unavailable.inspect("tenant", "storage"))
                .contains("identity=unavailable", "marker=match");
        assertUnavailable(() -> unavailable.verify(binding));
    }

    @Test
    void refusesDirectoryAndSymlinkMarkersWithoutChangingRegistration() throws Exception {
        String operation = UUID.randomUUID().toString();
        guard().register("tenant", "storage", operation);
        var registration = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        Path marker = root.resolve(".qwen-managed-storage.json");
        Path saved = temp.resolve("marker-backup");
        Files.move(marker, saved);
        Files.createDirectory(marker);
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        Files.delete(marker);
        Files.createSymbolicLink(marker, saved);
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease"))
                .isEqualTo(registration);
        Files.delete(marker);
        Files.move(saved, marker);
        guard().verify(binding);
    }

    @Test
    void rejectsUnavailableAndAmbiguousBirthTimeWithoutUsingDirectoryMtimeAsIdentity() throws Exception {
        FileTime birth = FileTime.from(Instant.parse("2026-09-30T00:00:00.123456789Z"));
        assertThatThrownBy(() -> WorkspaceStorageGuard.verifiedBirthTime(birth, birth))
                .isInstanceOf(java.io.IOException.class);
        assertThatThrownBy(() -> WorkspaceStorageGuard.verifiedBirthTime(FileTime.fromMillis(0), birth))
                .isInstanceOf(java.io.IOException.class);
        assertThat(WorkspaceStorageGuard.verifiedBirthTime(birth, FileTime.fromMillis(1)))
                .isEqualTo("2026-09-30T00:00:00.123456789Z");
        assertThat(WorkspaceStorageGuard.verifiedBirthTime(birth, FileTime.fromMillis(2)))
                .isEqualTo("2026-09-30T00:00:00.123456789Z");
    }

    @Test
    void retriesOnlyOriginalRegistrationAndNeverRecreatesMissingMarker() throws Exception {
        String operation = UUID.randomUUID().toString();
        guard().register("tenant", "storage", operation);
        assertUnavailable(() -> guard().register("tenant", "storage", UUID.randomUUID().toString()));
        jdbc.update("UPDATE managed_workspace_execution_lease"
                + " SET mount_state = 'UNVERIFIED', mount_revision = 0, mount_operation_id = ?",
                operation);
        assertUnavailable(() -> guard().register("tenant", "storage", UUID.randomUUID().toString()));
        guard().register("tenant", "storage", operation);
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM managed_workspace_execution_lease",
                Long.class)).isEqualTo(1);
        Files.delete(root.resolve(".qwen-managed-storage.json"));
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertThat(Files.exists(root.resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void persistedFenceBlocksNewWorkAndRequiresExactRevision() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        assertUnavailable(() -> guard().fence("tenant", "storage", 0, operation));
        guard().fence("tenant", "storage", 1, operation);
        guard().fence("tenant", "storage", 1, operation);
        assertThat(guard().inspect("tenant", "storage")).contains("state=fenced revision=1", "operation=" + operation);
        assertUnavailable(() -> guard().verify(binding));
        assertUnavailable(() -> guard().fence("tenant", "storage", 1,
                UUID.randomUUID().toString()));
        assertThat(jdbc.queryForObject("SELECT mount_operation_id"
                + " FROM managed_workspace_execution_lease", String.class)).isEqualTo(operation);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1,
                UUID.randomUUID().toString()));
        guard().restoreOriginal("tenant", "storage", 1, operation);
        guard().restoreOriginal("tenant", "storage", 1, operation);
        assertThat(guard().inspect("tenant", "storage")).contains("state=ready revision=2", "identity=match marker=match");
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, operation));
        guard().verify(binding);
    }

    @Test
    void concurrentRegistrationConvergesAfterBothPreparedTransactionsCommit() throws Exception {
        CountDownLatch prepared = new CountDownLatch(2);
        ThreadLocal<Integer> commits = ThreadLocal.withInitial(() -> 0);
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource) {
            @Override
            protected void doCommit(DefaultTransactionStatus status) {
                super.doCommit(status);
                commits.set(commits.get() + 1);
                if (commits.get() == 1) {
                    prepared.countDown();
                    try {
                        if (!prepared.await(5, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Both registrations must prepare");
                        }
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }
            }
        };
        String operation = UUID.randomUUID().toString();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> guard(manager).register("tenant", "storage", operation));
            var second = executor.submit(() -> guard(manager).register("tenant", "storage", operation));
            first.get(10, TimeUnit.SECONDS);
            second.get(10, TimeUnit.SECONDS);
        }
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM managed_workspace_execution_lease",
                Long.class)).isEqualTo(1);
        guard().verify(binding);
        guard().register("tenant", "storage", operation);
    }

    @Test
    void retriesRegistrationAfterReadyCommitAcknowledgmentIsLost() {
        AtomicInteger commits = new AtomicInteger();
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource) {
            @Override
            protected void doCommit(DefaultTransactionStatus status) {
                super.doCommit(status);
                if (commits.incrementAndGet() == 2) {
                    throw new IllegalStateException("READY acknowledgment lost");
                }
            }
        };
        String operation = UUID.randomUUID().toString();
        assertThatThrownBy(() -> guard(manager).register("tenant", "storage", operation))
                .isInstanceOf(IllegalStateException.class);
        var committed = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertThat(committed.get("mount_state")).isEqualTo("READY");
        guard().register("tenant", "storage", operation);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(committed);
        guard().verify(binding);
    }

    @Test
    void restoreRetryVerifiesPhysicalStateAndPreservesNewHolder() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        guard().fence("tenant", "storage", 1, operation);
        guard().restoreOriginal("tenant", "storage", 1, operation);
        jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = 'new-holder'");
        var committed = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        guard().restoreOriginal("tenant", "storage", 1, operation);
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(committed);
        Path marker = root.resolve(".qwen-managed-storage.json");
        byte[] original = Files.readAllBytes(marker);
        Files.delete(marker);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1, operation));
        Files.write(marker, original);
        Files.move(root, temp.resolve("old-root"));
        Files.createDirectory(root);
        Files.write(root.resolve(".qwen-managed-storage.json"), original);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1, operation));
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(committed);
    }

    @Test
    void fencedInspectionReportsPhysicalDamageAndHolderWithoutMutating() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        guard().fence("tenant", "storage", 1, operation);
        jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = 'retained-owner'");
        Files.move(root, temp.resolve("old-root"));
        Files.createDirectory(root);
        var committed = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease");
        assertThat(guard().inspect("tenant", "storage"))
                .contains("state=fenced revision=1", "operation=" + operation,
                        "holder=true", "identity=mismatch", "marker=unavailable");
        assertThat(jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease")).isEqualTo(committed);
        assertThat(Files.exists(root.resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void sameOperationConcurrentFencesConvergeAndOtherOperationsRefuse() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> guard().fence("tenant", "storage", 1, operation));
            var second = executor.submit(() -> guard().fence("tenant", "storage", 1, operation));
            first.get(10, TimeUnit.SECONDS);
            second.get(10, TimeUnit.SECONDS);
        }
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(guard().inspect("tenant", "storage")).contains("operation=" + operation);
    }

    private WorkspaceStorageGuard guard() {
        return guard(new DataSourceTransactionManager(dataSource));
    }

    private WorkspaceStorageGuard guard(PlatformTransactionManager manager) {
        return new WorkspaceStorageGuard(jdbc, manager, properties, path -> {
                    BasicFileAttributes attributes = Files.readAttributes(path,
                            BasicFileAttributes.class);
                    if (!attributes.isDirectory() || !path.equals(path.toRealPath())) {
                        throw new java.io.IOException("Root changed");
                    }
                    return new WorkspaceStorageGuard.Identity(path.toString(), "test-host",
                            "test-device", attributes.fileKey().toString(), attributes.creationTime().toInstant().toString());
                });
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
    }
}
