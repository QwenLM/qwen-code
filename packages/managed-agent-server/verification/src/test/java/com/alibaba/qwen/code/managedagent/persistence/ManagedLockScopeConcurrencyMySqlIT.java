package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.PublishToolResultRequest;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

@Timeout(30)
class ManagedLockScopeConcurrencyMySqlIT {
    private static final String TENANT = "scope-tenant";
    private static final String TOKEN = "a".repeat(32);
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ManagedAgentStore agents;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        agents = VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                events -> {}, mock(ManagedWorkspaceRegistry.class), new ManagedAgentProperties(), new SdkHarnessRules());
    }

    @AfterEach
    void close() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void answeredWatermarkDoesNotWaitForUnrelatedTenantPlacement() throws Exception {
        String session = transactions.execute(status -> agents.insertSessionCommand(TENANT, "CREATE_SESSION",
                "create", "digest", "qwen-code", "1", null, List.of(), null).sessionId());
        var admitted = transactions.execute(status -> agents.beginOperation(TENANT, session, OperationKind.CLOSE,
                "sha256:" + "d".repeat(64), "close", "close-digest").operation());
        var claimed = transactions.execute(status -> agents.claimOperation(TENANT, session, admitted.operationId(),
                "owner", Duration.ofMinutes(1)).orElseThrow());
        assertWithoutGuardWait("answered", "runtime_placement", () -> transactions.executeWithoutResult(status ->
                agents.markOperationAnswered(TENANT, session, claimed.operationId(), "owner", claimed.claimGeneration())));
        assertThat(jdbc.queryForObject("SELECT budget_exempt_attempt FROM ma_operation WHERE operation_id = ?",
                Integer.class, claimed.operationId())).isEqualTo(1);
        transactions.executeWithoutResult(status -> agents.markOperationAnswered(TENANT, session,
                claimed.operationId(), "other-owner", claimed.claimGeneration()));
        transactions.executeWithoutResult(status -> agents.markOperationAnswered(TENANT, session,
                claimed.operationId(), "owner", claimed.claimGeneration() - 1));
        jdbc.update("UPDATE ma_operation SET claim_until = 0 WHERE operation_id = ?", claimed.operationId());
        transactions.executeWithoutResult(status -> agents.markOperationAnswered(TENANT, session,
                claimed.operationId(), "owner", claimed.claimGeneration()));
        assertThat(jdbc.queryForObject("SELECT budget_exempt_attempt FROM ma_operation WHERE operation_id = ?",
                Integer.class, claimed.operationId())).isEqualTo(1);
    }

    @Test
    void ordinaryInlineToolResultDoesNotWaitForUnrelatedPublication() throws Exception {
        var journal = VerificationFixtures.managedSessionStore(jdbc);
        transactions.execute(status -> journal.acquireWriter(TENANT, "journal-session", TOKEN,
                new AcquireWriterRequest("workspace", "writer", 60_000L)));
        var request = new PublishToolResultRequest("workspace", "writer", 1, "result",
                "managed-tool-result-content", 1, 1, DigestUtils.sha256Hex(new byte[] {1}), "AQ==");
        assertWithoutGuardWait("inline-result", "output_publication", () -> transactions.executeWithoutResult(status ->
                journal.publishToolResult(TENANT, "journal-session", TOKEN, request)));
    }

    @Test
    void lifecycleRenewDoesNotWaitForUnrelatedTenantPlacement() throws Exception {
        var fixture = new WorkspaceLifecycleStoreTest.Fixture(database.source());
        var operation = fixture.admit(OperationKind.CLOSE);
        assertWithoutGuardWait("lifecycle-renew", "runtime_placement", "tenant", () ->
                assertThat(fixture.transactions.<Boolean>execute(status -> fixture.store.renewLifecycleOperation(
                        "tenant", fixture.session, operation.operationId(), operation.leaseOwner(),
                        operation.claimGeneration(), Duration.ofSeconds(30)))).isTrue());
    }

    @Test
    void missingLifecycleSessionDoesNotMaterializeRoots() {
        var claim = transactions.execute(status -> agents.claimOperation(TENANT, "missing-session", "missing-operation",
                "owner", Duration.ofSeconds(30)));
        assertThat(claim).isEmpty();
        Boolean renewed = transactions.execute(status -> agents.renewLifecycleOperation(TENANT, "missing-session",
                "missing-operation", "owner", 1, Duration.ofSeconds(30)));
        assertThat(renewed).isFalse();
        transactions.executeWithoutResult(status -> agents.markOperationAnswered(TENANT, "missing-session",
                "missing-operation", "owner", 1));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head", Long.class)).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"retry", "block", "fail"})
    void clearedClaimCannotAuthorizeThroughAnOlderRepeatableReadSnapshot(String action) throws Exception {
        var fixture = new WorkspaceLifecycleStoreTest.Fixture(database.source());
        var operation = fixture.admit(OperationKind.CLOSE);
        var authority = new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration());
        try (Connection readView = database.source().getConnection()) {
            readView.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            readView.setAutoCommit(false);
            try (var snapshot = readView.prepareStatement("SELECT claim_lease_until FROM ma_session_head"
                    + " WHERE head_kind = 'HARNESS' AND tenant_id = 'tenant' AND harness_session_id = ?")) {
                snapshot.setString(1, fixture.session);
                try (var rows = snapshot.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getLong(1)).isGreaterThan(System.currentTimeMillis());
                }
            }
            fixture.transactions.executeWithoutResult(status -> {
                switch (action) {
                    case "retry" -> fixture.store.retryOperation("tenant", fixture.session, operation.operationId(),
                            operation.leaseOwner(), operation.claimGeneration(), System.currentTimeMillis() + 1_000);
                    case "block" -> fixture.store.blockLifecycleOperation("tenant", fixture.session, operation.operationId(),
                            operation.leaseOwner(), operation.claimGeneration(), "blocked", System.currentTimeMillis() + 1_000);
                    case "fail" -> assertThat(fixture.store.failOperation("tenant", fixture.session, operation.operationId(),
                            operation.leaseOwner(), operation.claimGeneration(), "failed")).isTrue();
                    default -> throw new IllegalArgumentException(action);
                }
            });
            assertThat(jdbc.queryForObject("SELECT claim_lease_until FROM ma_session_head WHERE head_kind = 'HARNESS'"
                    + " AND tenant_id = 'tenant' AND harness_session_id = ?", Long.class, fixture.session)).isNull();
            JdbcRuntimeBindingRepository.lockPlacementDomain(readView, "tenant");
            assertThatThrownBy(() -> JdbcRuntimeBindingRepository.requireHarnessAdmission(readView, fixture.scope(),
                    fixture.session, authority))
                    .as("cleared " + action + " claim cannot be accepted from an old read view")
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            failure -> assertThat(failure.getCode()).isEqualTo("runtime_admission_closed"));
            readView.rollback();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"retry", "block"})
    void admittedAuthorityHoldsItsMirrorUntilTheAdmissionTransactionEnds(String action) throws Exception {
        var fixture = new WorkspaceLifecycleStoreTest.Fixture(database.source());
        var operation = fixture.admit(OperationKind.CLOSE);
        var authority = new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration());
        try (Connection admission = database.source().getConnection(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            admission.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(admission, "tenant");
            JdbcRuntimeBindingRepository.requireHarnessAdmission(admission, fixture.scope(), fixture.session, authority);
            Future<?> mutation = executor.submit(() -> fixture.transactions.executeWithoutResult(status -> {
                if ("retry".equals(action)) {
                    fixture.store.retryOperation("tenant", fixture.session, operation.operationId(),
                            operation.leaseOwner(), operation.claimGeneration(), System.currentTimeMillis() + 1_000);
                } else {
                    fixture.store.blockLifecycleOperation("tenant", fixture.session, operation.operationId(),
                            operation.leaseOwner(), operation.claimGeneration(), "blocked", System.currentTimeMillis() + 1_000);
                }
            }));
            boolean blocked;
            try {
                blocked = waitsForLock("admission-mirror-" + action, mutation);
            } finally {
                admission.rollback();
            }
            mutation.get(5, TimeUnit.SECONDS);
            assertThat(blocked).as("claim mirror mutation must wait for an admitted authority transaction").isTrue();
            assertThat(jdbc.queryForObject("SELECT claim_lease_until FROM ma_session_head WHERE head_kind = 'HARNESS'"
                    + " AND tenant_id = 'tenant' AND harness_session_id = ?", Long.class, fixture.session)).isNull();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"LOCAL", "SSH_LOCAL"})
    void physicalRecoveryKeysKeepTheirOriginalFenceSemantics(String kind) {
        storageWriters(false);
        jdbc.update("UPDATE ma_storage SET storage_kind = ?", kind);
        jdbc.update("UPDATE ma_storage_owner SET storage_kind = ?", kind);
        String readyKey = transactions.execute(status -> "LOCAL".equals(kind)
                ? LocalStorageOwners.key(jdbc, TENANT, "storage") : SshWorkspaceStore.physicalKey(jdbc, TENANT, "storage"));
        assertThat(readyKey).isEqualTo("d".repeat(64));
        jdbc.update(fenceSql("physical"));
        if ("LOCAL".equals(kind)) {
            String recoveryKey = transactions.execute(status -> LocalStorageOwners.key(jdbc, TENANT, "storage"));
            assertThat(recoveryKey).isEqualTo(readyKey);
        } else {
            assertThatThrownBy(() -> transactions.execute(status -> SshWorkspaceStore.physicalKey(jdbc, TENANT, "storage")))
                    .isInstanceOf(RuntimeBrokerException.class);
        }
        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, "storage")))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        failure -> assertThat(failure.getCode()).isEqualTo("workspace_unavailable"));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void ordinaryCommitsSharingStorageDoNotWaitForEachOther(boolean distinctAliases) throws Exception {
        var journal = storageWriters(distinctAliases);
        CountDownLatch firstCommitted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> first = executor.submit(() -> transactions.executeWithoutResult(status -> {
                journal.commit(TENANT, "storage-a", TOKEN, JournalLockContractTest.genesis());
                firstCommitted.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }));
            assertThat(firstCommitted.await(5, TimeUnit.SECONDS)).isTrue();
            Future<?> second = executor.submit(() -> transactions.executeWithoutResult(status ->
                    journal.commit(TENANT, "storage-b", TOKEN, JournalLockContractTest.genesis())));
            boolean blocked;
            try {
                blocked = waitsForLock("shared-storage-commit", second);
            } finally {
                release.countDown();
            }
            first.get(5, TimeUnit.SECONDS);
            second.get(5, TimeUnit.SECONDS);
            assertThat(blocked).as("unrelated Session commits do not lock shared storage").isFalse();
        } finally {
            release.countDown();
        }
    }

    @ParameterizedTest
    @CsvSource({"alias, commit", "physical, commit", "alias, tool-result", "physical, tool-result"})
    void ordinaryJournalDoesNotWaitForStorageMetadata(String domain, String route) throws Exception {
        var journal = storageWriters(false);
        try (var blocker = database.source().getConnection(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            blocker.setAutoCommit(false);
            String sql = "alias".equals(domain)
                    ? "SELECT alias_key FROM ma_storage WHERE alias_key = ? FOR UPDATE"
                    : "SELECT storage_key FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE";
            try (var statement = blocker.prepareStatement(sql)) {
                statement.setString(1, "alias".equals(domain)
                        ? JdbcRuntimeBindingRepository.storageAliasKey(TENANT, "storage") : "d".repeat(64));
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.next()).isFalse();
                }
            }
            var operation = executor.submit(() -> transactions.execute(status -> "commit".equals(route)
                    ? journal.commit(TENANT, "storage-a", TOKEN, JournalLockContractTest.genesis())
                    : journal.publishToolResult(TENANT, "storage-a", TOKEN,
                            new PublishToolResultRequest("workspace", "writer", 1, "result",
                                    "managed-tool-result-content", 1, 1, DigestUtils.sha256Hex(new byte[] {1}), "AQ=="))));
            boolean blocked;
            try {
                blocked = waitsForLock(route + "-" + domain, operation);
            } finally {
                blocker.rollback();
            }
            assertThat(operation.get(5, TimeUnit.SECONDS)).isNotNull();
            assertThat(blocked).as("ordinary %s does not lock %s metadata", route, domain).isFalse();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"alias", "physical"})
    void metadataUpdatesDoNotWaitForJournalAndCommittedFencesStillReject(String domain) throws Exception {
        var journal = storageWriters(false);
        CountDownLatch admitted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> reader = executor.submit(() -> transactions.executeWithoutResult(status -> {
                journal.commit(TENANT, "storage-a", TOKEN, JournalLockContractTest.genesis());
                admitted.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }));
            assertThat(admitted.await(5, TimeUnit.SECONDS)).isTrue();
            Future<?> writer = executor.submit(() -> transactions.executeWithoutResult(status ->
                    jdbc.update("alias".equals(domain)
                            ? "UPDATE ma_storage SET gmt_modified = 1 WHERE storage_id = 'storage'"
                            : "UPDATE ma_storage_owner SET member_count = member_count + 1 WHERE storage_id = 'storage'")));
            boolean blocked;
            try {
                blocked = waitsForLock(domain + "-mutation", writer);
            } finally {
                release.countDown();
            }
            reader.get(5, TimeUnit.SECONDS);
            writer.get(5, TimeUnit.SECONDS);
            assertThat(blocked).as("metadata updates do not wait for the journal transaction").isFalse();
            jdbc.update(fenceSql(domain));
            assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
                    WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, "storage")))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            failure -> assertThat(failure.getCode()).isEqualTo("workspace_unavailable"));
            if ("alias".equals(domain)) {
                var committed = transactions.execute(status -> journal.commit(TENANT, "storage-b", TOKEN,
                        JournalLockContractTest.genesis()));
                assertThat(committed).isNotNull();
            } else {
                assertThatThrownBy(() -> transactions.execute(status -> journal.commit(TENANT, "storage-b", TOKEN,
                        JournalLockContractTest.genesis())))
                        .isInstanceOfSatisfying(RuntimeBrokerException.class,
                                failure -> assertThat(failure.getCode()).isEqualTo("workspace_unavailable"));
            }
        } finally {
            release.countDown();
        }
    }

    /**
     * The Session-scoped read admission behind action responses: two Sessions
     * on one storage share it, and a fence writer still waits for it.
     */
    @Test
    void sessionScopedReadAdmissionSharesStorageAndHoldsOffTheFence() throws Exception {
        storageWriters(false);
        CountDownLatch admitted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> reader = executor.submit(() -> transactions.executeWithoutResult(status -> {
                WorkspaceMigrationAdmission.requireSessionOpenForAdmission(jdbc, TENANT, "storage-a");
                admitted.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }));
            assertThat(admitted.await(5, TimeUnit.SECONDS)).isTrue();
            Future<?> neighbour = executor.submit(() -> transactions.executeWithoutResult(status ->
                    WorkspaceMigrationAdmission.requireSessionOpenForAdmission(jdbc, TENANT, "storage-b")));
            boolean neighbourBlocked;
            boolean fenceBlocked;
            Future<?> fence;
            try {
                neighbourBlocked = waitsForLock("session-read-admission", neighbour);
                fence = executor.submit(() -> transactions.executeWithoutResult(status -> jdbc.update(fenceSql("alias"))));
                fenceBlocked = waitsForLock("session-read-fence", fence);
            } finally {
                release.countDown();
            }
            reader.get(5, TimeUnit.SECONDS);
            neighbour.get(5, TimeUnit.SECONDS);
            fence.get(5, TimeUnit.SECONDS);
            assertThat(neighbourBlocked).as("Sessions sharing storage share read admission").isFalse();
            assertThat(fenceBlocked).as("the fence writer waits for the admitted reader").isTrue();
        } finally {
            release.countDown();
        }
    }

    private String fenceSql(String domain) {
        return "alias".equals(domain)
                ? "UPDATE ma_storage SET fence_operation_id = 'fence' WHERE storage_id = 'storage'"
                : "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = '" + "d".repeat(64) + "'";
    }

    private ManagedSessionStore storageWriters(boolean distinctAliases) {
        var journal = VerificationFixtures.managedSessionStore(jdbc);
        for (String session : List.of("storage-a", "storage-b")) {
            transactions.execute(status -> journal.acquireWriter(TENANT, session, TOKEN,
                    new AcquireWriterRequest("workspace", "writer", 60_000L)));
        }
        String physical = "d".repeat(64);
        for (String alias : distinctAliases ? List.of("storage", "storage-other") : List.of("storage")) {
            jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                            + " storage_kind, registration_state, registration_revision, registration_json)"
                            + " VALUES (?, ?, ?, ?, ?, ?, 'LOCAL', 'REGISTERED', 1, '{}')",
                    JdbcRuntimeBindingRepository.storageAliasKey(TENANT, alias),
                    JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                    JdbcRuntimeBindingRepository.storageFenceKey(alias), TENANT, alias, physical);
        }
        jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id, storage_id, mount_state)"
                + " VALUES (?, ?, 'LOCAL', ?, 'storage', 'READY')", physical, physical, TENANT);
        jdbc.update("UPDATE ma_session SET workspace_storage_id = 'storage' WHERE tenant_id = ?", TENANT);
        if (distinctAliases) {
            jdbc.update("UPDATE ma_session SET workspace_storage_id = 'storage-other' WHERE tenant_id = ? AND session_id = 'storage-b'", TENANT);
        }
        return journal;
    }

    private void assertWithoutGuardWait(String label, String domain, Runnable operation) throws Exception {
        assertWithoutGuardWait(label, domain, TENANT, operation);
    }

    private void assertWithoutGuardWait(String label, String domain, String tenant, Runnable operation) throws Exception {
        try (Connection blocker = database.source().getConnection(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            blocker.setAutoCommit(false);
            if ("runtime_placement".equals(domain)) {
                JdbcRuntimeBindingRepository.lockPlacementDomain(blocker, tenant);
            } else {
                new TransactionTemplate(new DataSourceTransactionManager(database.source())).executeWithoutResult(status ->
                        ToolPublicationRetentionStore.lockTenant(jdbc, tenant));
                try (var lock = blocker.prepareStatement("SELECT tenant_id FROM ma_tenant_guard WHERE tenant_id = ? AND guard_domain = ? FOR UPDATE")) {
                    lock.setString(1, tenant);
                    lock.setString(2, domain);
                    lock.executeQuery().close();
                }
            }
            Future<?> invocation = executor.submit(operation);
            boolean blocked;
            try {
                blocked = waitsForLock(label, invocation);
            } finally {
                blocker.rollback();
            }
            invocation.get(5, TimeUnit.SECONDS);
            assertThat(blocked).as(label + " should complete while an unrelated tenant guard remains held").isFalse();
        }
    }

    private boolean waitsForLock(String label, Future<?> invocation) throws Exception {
        try {
            invocation.get(2, TimeUnit.SECONDS);
            System.out.println("LOCK_SCOPE_PROBE label=" + label + " completed_while_guard_held=true");
            return false;
        } catch (TimeoutException timeout) {
            var locks = jdbc.queryForList("SELECT r.OBJECT_NAME, r.INDEX_NAME FROM performance_schema.data_lock_waits w"
                    + " JOIN performance_schema.data_locks r ON w.REQUESTING_ENGINE_LOCK_ID = r.ENGINE_LOCK_ID");
            System.out.println("LOCK_SCOPE_PROBE label=" + label + " completed_while_guard_held=false locks=" + locks);
            assertThat(locks).as("the operation is observably waiting on an InnoDB lock").isNotEmpty();
            return true;
        }
    }
}
