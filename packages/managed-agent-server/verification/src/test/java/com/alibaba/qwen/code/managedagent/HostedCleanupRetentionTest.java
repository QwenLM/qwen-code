package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedRuntimeRetentionGuard;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.StoreLockTrace;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.UnaryOperator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;

class HostedCleanupRetentionTest {
    private final ObjectMapper json = new ObjectMapper();
    private StoreLockTrace trace;
    private DataSource source;
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository runtimeSessions;
    private ExtensionRecordJournal journal;
    private RuntimeBindingRecord original;
    private RuntimeScope scope;

    protected DataSource dataSource() {
        var data = new JdbcDataSource();
        data.setURL("jdbc:h2:mem:cleanup-retention-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return data;
    }

    @BeforeEach
    void setup() {
        trace = new StoreLockTrace(dataSource());
        source = trace;
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]));
        runtimeSessions = new JdbcRuntimeSessionRepository(source);
        journal = transactions.execute(ignored -> new ExtensionRecordJournal(com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc),
                "tenant", "workspace", "harness").open());
        scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "session");
        original = retire(new RuntimeProvisionRequest(scope, "harness", "local-process", "storage"));
    }

    @Test
    void owedCleanupPreservesExactReleasedOwnerAcrossSweepAndReopen() {
        cleanup("one", "prompt", "owed");
        assertThat(sweep().bindingsDeleted()).isZero();
        assertThat(bindings.findById(original.getBindingId())).isNotNull();
        assertThat(runtimeSessions.findById(scope, "prompt").getState()).isEqualTo(RuntimeSessionRecord.State.RELEASED);
        try (var broker = broker()) {
            assertThat(broker.releaseOriginal("harness", "prompt", original.getBindingId(), original.getGeneration())
                    .toCompletableFuture().join()).isTrue();
            assertThatThrownBy(() -> broker.releaseOriginal("harness", "prompt", "never-existed", original.getGeneration())
                    .toCompletableFuture().join()).hasRootCauseInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
            assertThatThrownBy(() -> broker.releaseOriginal("harness", "prompt", original.getBindingId(), original.getGeneration() + 1)
                    .toCompletableFuture().join()).hasRootCauseInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
            assertThatThrownBy(() -> broker.releaseOriginal("foreign", "prompt", original.getBindingId(), original.getGeneration())
                    .toCompletableFuture().join()).hasRootCauseInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        }
        cleanup("one", "prompt", "confirmed");
        assertCollected();
        assertThat(bindings.findById(original.getBindingId())).isNull();
    }

    @Test
    void oneConfirmationCannotReleaseAnotherCleanupDebt() {
        cleanup("one", "prompt", "owed");
        cleanup("two", "other-prompt", "owed");
        cleanup("one", "prompt", "confirmed");
        assertThat(sweep().bindingsDeleted()).isZero();
        cleanup("two", "other-prompt", "confirmed");
        assertCollected();
    }

    @Test
    void rollbackKeepsTheJournalAndItsCleanupProjectionAtomic() {
        CommitTransactionRequest request = cleanupRequest("rolled-back", "prompt", "owed");
        transactions.executeWithoutResult(status -> {
            journal.commit(request);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Integer.class))
                    .isEqualTo(1);
            status.setRollbackOnly();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Integer.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT journal_revision FROM ma_session_head WHERE session_id = ?", Long.class, "harness"))
                .isEqualTo(1);
        assertCollected();
    }

    @Test
    void unverifiedHistoricalJournalRetainsItsBindingWithoutRestamping() {
        jdbc.update("UPDATE ma_session_head SET cleanup_head_revision = NULL");
        cleanup("one", "prompt", "owed");
        cleanup("one", "prompt", "confirmed");
        assertThat(jdbc.queryForObject("SELECT cleanup_head_revision FROM ma_session_head WHERE session_id = ?", Long.class, "harness"))
                .isNull();
        assertThat(sweep().bindingsDeleted()).isZero();
        jdbc.update("UPDATE ma_session_head SET state = 'DELETED', compacted_through_revision = journal_revision");
        assertCollected();
    }

    @Test
    void sharedBindingRetainsItsOriginalSessionUntilCleanupConfirmation() {
        scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
        original = retire(new RuntimeProvisionRequest(scope, null, "local-process", "storage"));
        cleanup("shared", "prompt", "owed");
        sweep();
        assertThat(bindings.findById(original.getBindingId())).isNotNull();
        try (var broker = broker()) {
            assertThat(broker.releaseOriginal("harness", "prompt", original.getBindingId(), original.getGeneration())
                    .toCompletableFuture().join()).isTrue();
            assertThatThrownBy(() -> broker.releaseOriginal("foreign", "prompt", original.getBindingId(), original.getGeneration())
                    .toCompletableFuture().join()).hasRootCauseInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        }
        cleanup("shared", "prompt", "confirmed");
        assertCollected();
    }

    @Test
    void cleanupIdentityCannotChangeItsDescriptor() {
        cleanup("one", "prompt", "owed");
        assertThatThrownBy(() -> cleanup("one", "other-prompt", "owed"))
                .hasMessageContaining("Cleanup identity changed");
        assertThat(sweep().bindingsDeleted()).isZero();
    }

    @Test
    void cleanupCannotBeAdmittedAfterItsOriginalBindingWasCollected() {
        assertCollected();
        assertCleanupRejected(cleanupRequest("late", "prompt", "owed"));
    }

    @Test
    void cleanupCannotNameAnotherRuntimeGeneration() {
        assertCleanupRejected(cleanupRequest("wrong-generation", "prompt", "owed", original.getGeneration() + 1));
    }

    @Test
    void cleanupCannotNameAnotherTenantsBinding() {
        scope = new RuntimeScope("other-tenant", "workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "session");
        original = retire(new RuntimeProvisionRequest(scope, "harness", "local-process", "storage"));
        assertCleanupRejected(cleanupRequest("wrong-tenant", "prompt", "owed"));
    }

    @Test
    void cleanupCannotNameAnotherWorkspacesBinding() {
        scope = new RuntimeScope("tenant", "other-workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "session");
        original = retire(new RuntimeProvisionRequest(scope, "harness", "local-process", "storage"));
        assertCleanupRejected(cleanupRequest("wrong-workspace", "prompt", "owed"));
    }

    @Test
    void cleanupCannotNameAnotherWorkspaceGeneration() {
        scope = new RuntimeScope("tenant", "workspace", "2", "/workspace", "sha256:" + "a".repeat(64), "session");
        original = retire(new RuntimeProvisionRequest(scope, "harness", "local-process", "storage"));
        assertCleanupRejected(cleanupRequest("wrong-workspace-generation", "prompt", "owed"));
    }

    @Test
    void cleanupConfirmationDoesNotRequireACollectedBinding() {
        assertCollected();
        cleanup("late-confirmation", "prompt", "confirmed");
        assertThat(jdbc.queryForObject("SELECT journal_revision FROM ma_session_head WHERE session_id = ?", Long.class, "harness"))
                .isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Long.class))
                .isZero();
    }

    @Test
    void committedCleanupReplaysAfterItsBindingWasCollected() {
        var owed = cleanupRequest("one", "prompt", "owed");
        assertThat(transactions.execute(status -> journal.commit(owed)).replayed()).isFalse();
        journal.committed(owed);
        var confirmed = cleanupRequest("one", "prompt", "confirmed");
        assertThat(transactions.execute(status -> journal.commit(confirmed)).replayed()).isFalse();
        journal.committed(confirmed);
        assertCollected();
        var before = journalState();
        assertThat(transactions.execute(status -> journal.commit(owed)).replayed()).isTrue();
        assertThat(transactions.execute(status -> journal.commit(confirmed)).replayed()).isTrue();
        assertThat(journalState()).isEqualTo(before);
    }

    @Test
    void cleanupAcquiresPlacementBeforeItsSessionRoot() {
        assertCleanupPlacement(records -> records, 0);
    }

    @Test
    void cleanupWithCarriageReturnAcquiresPlacementBeforeItsSessionRoot() {
        assertCleanupPlacement(records -> records.replace("\"managedSession\":", "\r\"managedSession\":"), 0);
    }

    @Test
    void cleanupAfterAnotherEventAcquiresPlacementBeforeItsSessionRoot() {
        assertCleanupPlacement(records -> {
            String[] lines = records.split("\n");
            var cleanup = (ObjectNode) ManagedExtensionRecordStore.parse(lines[0]);
            var preceding = cleanup.deepCopy();
            var event = (ObjectNode) preceding.path("managedSession");
            event.put("kind", "operation.replayed").put("eventId", "preceding-event");
            event.set("payload", json.createObjectNode());
            var cleanupEvent = (ObjectNode) cleanup.path("managedSession");
            cleanupEvent.put("sequence", cleanupEvent.path("sequence").longValue() + 1);
            return preceding + "\n" + cleanup + "\n" + lines[1] + "\n";
        }, 1);
    }

    private void assertCleanupPlacement(UnaryOperator<String> editRecords, int extraEvents) {
        var request = cleanupRequest("placement", "prompt", "owed", original.getGeneration(), editRecords, extraEvents);
        trace.clear();
        transactions.executeWithoutResult(status -> journal.commit(request));
        trace.assertPlacementBeforeSession("tenant", "harness");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Long.class))
                .isEqualTo(1);
    }

    void committedCleanupProtectsBindingFromSweepWaitingForPlacement() throws Exception {
        var admitted = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var checks = new AtomicInteger();
        var guard = new JdbcRuntimeRetention.ReferenceGuard() {
            private final ManagedRuntimeRetentionGuard delegate = new ManagedRuntimeRetentionGuard();

            @Override
            public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException {
                assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_READ_COMMITTED);
                checks.incrementAndGet();
                return delegate.bindingReferenced(connection, binding);
            }

            @Override
            public boolean executionReferenced(Connection connection, String execution) throws SQLException {
                return delegate.executionReferenced(connection, execution);
            }
        };
        var request = cleanupRequest("wins-before-sweep", "prompt", "owed");
        try (var pool = Executors.newFixedThreadPool(2)) {
            var writer = pool.submit(() -> transactions.executeWithoutResult(status -> {
                journal.commit(request);
                admitted.countDown();
                try {
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }));
            try {
                assertThat(admitted.await(5, TimeUnit.SECONDS)).isTrue();
                var retention = pool.submit(() -> new JdbcRuntimeRetention(source, bindings, guard)
                        .sweep(Duration.ofDays(30), 100, null));
                await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sys.innodb_lock_waits"
                                + " WHERE locked_table LIKE '%ma_tenant_guard%'", Long.class)).isPositive());
                assertThat(checks.get()).as("retention cannot inspect references before placement is released").isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Long.class))
                        .isZero();
                release.countDown();
                writer.get(5, TimeUnit.SECONDS);
                var result = retention.get(5, TimeUnit.SECONDS);
                assertThat(result.bindingsScanned()).isEqualTo(1);
                assertThat(result.bindingsDeleted() + result.sessionsDeleted() + result.executionsDeleted()).isZero();
                assertThat(checks.get()).isPositive();
                assertThat(bindings.findById(original.getBindingId())).isNotNull();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Long.class))
                        .isEqualTo(1);
            } finally {
                release.countDown();
            }
        }
        journal.committed(request);
        cleanup("wins-before-sweep", "prompt", "confirmed");
        assertCollected();
    }

    @Test
    void cleanupAdmissionCannotRacePastTheFinalRetentionReferenceCheck() throws Exception {
        var before = journalState();
        var finalCheck = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var checks = new AtomicInteger();
        var guard = new JdbcRuntimeRetention.ReferenceGuard() {
            private final ManagedRuntimeRetentionGuard delegate = new ManagedRuntimeRetentionGuard();

            @Override
            public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException {
                assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_READ_COMMITTED);
                boolean referenced = delegate.bindingReferenced(connection, binding);
                if (binding.getBindingId().equals(original.getBindingId()) && !referenced && checks.incrementAndGet() == 2) {
                    finalCheck.countDown();
                    try {
                        assertThat(release.await(10, TimeUnit.SECONDS)).isTrue();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }
                return referenced;
            }

            @Override
            public boolean executionReferenced(Connection connection, String execution) throws SQLException {
                return delegate.executionReferenced(connection, execution);
            }
        };
        try (var pool = Executors.newFixedThreadPool(2)) {
            var retention = pool.submit(() -> new JdbcRuntimeRetention(source, bindings, guard)
                    .sweep(Duration.ofDays(30), 100, null));
            assertThat(finalCheck.await(5, TimeUnit.SECONDS)).isTrue();
            var writer = pool.submit(() -> catchThrowable(() -> cleanup("racing", "prompt", "owed")));
            try {
                try {
                    writer.get(2, TimeUnit.SECONDS);
                    System.out.println("HOSTED_CLEANUP_PROBE writer_completed_before_retention_release=true");
                } catch (TimeoutException expected) {
                    System.out.println("HOSTED_CLEANUP_PROBE writer_completed_before_retention_release=false");
                }
            } finally {
                release.countDown();
            }
            assertThat(retention.get(5, TimeUnit.SECONDS).bindingsDeleted()).isEqualTo(1);
            Throwable failure = writer.get(5, TimeUnit.SECONDS);
            long owed = jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'HOSTED_CLEANUP'", Long.class);
            assertThat(bindings.findById(original.getBindingId())).isNull();
            System.out.println("HOSTED_CLEANUP_PROBE runtime_removed=true dangling_references=" + owed);
            assertCleanupConflict(failure);
            assertThat(owed).isZero();
            assertThat(journalState()).isEqualTo(before);
        } finally {
            release.countDown();
        }
    }

    private void assertCleanupRejected(CommitTransactionRequest request) {
        var before = journalState();
        Throwable failure = catchThrowable(() -> transactions.executeWithoutResult(status -> journal.commit(request)));
        assertCleanupConflict(failure);
        assertThat(journalState()).isEqualTo(before);
    }

    private static void assertCleanupConflict(Throwable failure) {
        assertThat(failure).isInstanceOfSatisfying(ManagedAgentException.class, error -> {
            assertThat(error.getStatus()).isEqualTo(409);
            assertThat(error.getCode()).isEqualTo("managed_session_cleanup_conflict");
        });
    }

    protected Map<String, Object> journalState() {
        var state = new LinkedHashMap<String, Object>();
        state.put("head", jdbc.queryForMap("SELECT journal_revision, committed_sequence, cleanup_head_revision"
                + " FROM ma_session_head WHERE session_id = ?", "harness"));
        for (String table : java.util.List.of("ma_session_journal_tx", "ma_session_record", "ma_resource", "ma_resource_ref")) {
            state.put(table, jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class));
        }
        return state;
    }

    private void cleanup(String id, String prompt, String state) {
        CommitTransactionRequest request = cleanupRequest(id, prompt, state);
        transactions.executeWithoutResult(ignored -> journal.commit(request));
        journal.committed(request);
    }

    protected CommitTransactionRequest cleanupRequest(String id, String prompt, String state) {
        return cleanupRequest(id, prompt, state, original.getGeneration());
    }

    private CommitTransactionRequest cleanupRequest(String id, String prompt, String state, long generation) {
        return cleanupRequest(id, prompt, state, generation, records -> records, 0);
    }

    private CommitTransactionRequest cleanupRequest(String id, String prompt, String state, long generation,
            UnaryOperator<String> editRecords, int extraEvents) {
        ObjectNode body = json.createObjectNode().put("v", 1).put("promptId", prompt)
                .put("runtimeSessionId", prompt).put("bindingId", original.getBindingId())
                .put("generation", Long.toString(generation)).put("workspaceGeneration", "1")
                .put("fileHistoryTurnId", prompt);
        body.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", "harness");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String resource = ExtensionRecordJournal.resourceId(bytes);
        var descriptor = new CommitResource(resource, "hosted-turn-cleanup", 1, bytes.length,
                ExtensionRecordJournal.sha256(bytes), Base64.getEncoder().encodeToString(bytes));
        CommitTransactionRequest template = journal.request("hostedCleanup", id + ":" + state + ":" + prompt,
                "{}".getBytes(StandardCharsets.UTF_8), 1000, event -> {
                    event.put("kind", "hosted.cleanup").put("eventId", "cleanup:" + id + ":" + state + ":" + prompt);
                    ObjectNode payload = event.putObject("payload").put("cleanupId", id).put("state", state);
                    payload.putObject("descriptorRef").put("resourceId", resource).put("kind", "hosted-turn-cleanup")
                            .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", descriptor.digest());
                }, editRecords, extraEvents);
        var resources = new java.util.ArrayList<>(template.resources());
        resources.add(descriptor);
        return new CommitTransactionRequest(template.workspaceId(), template.writerId(), template.writerGeneration(),
                template.expectedJournalRevision(), template.expectedCommittedSequence(), template.transactionId(),
                template.operation(), template.commandId(), template.contentDigest(), template.firstSequence(),
                template.lastSequence(), template.eventCount(), template.eventsDigest(), template.previousCommitDigest(),
                template.commitDigest(), template.activationEpoch(), template.latestCheckpointResourceId(),
                template.recordCount(), template.recordBytesBase64(), template.recordDigest(), resources);
    }

    protected void assertCollected() {
        var result = sweep();
        assertThat(result.bindingsDeleted()).as("%s heads=%s refs=%s bindings=%s sessions=%s", result,
                jdbc.queryForList("SELECT journal_revision, cleanup_head_revision FROM ma_session_head"),
                jdbc.queryForList("SELECT owner_kind, owner_revision FROM ma_resource_ref"),
                jdbc.queryForList("SELECT binding_state, last_active_at FROM ma_runtime_binding"),
                jdbc.queryForList("SELECT session_state, last_active_at FROM ma_runtime_session")).isEqualTo(1);
    }

    private JdbcRuntimeRetention.BatchResult sweep() {
        return new JdbcRuntimeRetention(source, new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("key", new byte[32])), new ManagedRuntimeRetentionGuard())
                .sweep(Duration.ofDays(30), 100, null);
    }

    private RuntimeBrokerService broker() {
        return new RuntimeBrokerService(harness -> CompletableFuture.completedFuture(scope), mock(RuntimeProvisioner.class),
                mock(RuntimeTransport.class), new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32])),
                new JdbcRuntimeSessionRepository(source), new JdbcToolExecutionRepository(source),
                "cleanup-test", Duration.ofMinutes(1), Duration.ofMinutes(1));
    }

    private RuntimeBindingRecord retire(RuntimeProvisionRequest request) {
        var created = bindings.findOrCreate(request);
        var claim = bindings.claimOperation(created.getBindingId(), "fixture", Duration.ofSeconds(1));
        var seed = claim.getProvisionSeed();
        var ready = bindings.compareAndSet(claim, claim.withAttestation(new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()),
                new RuntimeResourceHandle("local-process", 1, Map.of("worker", "fixture")), Instant.now(), Instant.now()));
        var draining = bindings.compareAndSet(ready, ready.withDrainRequested(true, Instant.now()));
        var receipt = new RuntimeDrainReceipt(draining.getBindingId(), draining.getGeneration(),
                seed.getProvisionRequestId(), draining.getResourceHandle(), Instant.now());
        var old = Instant.parse("2000-01-01T00:00:00Z");
        var retired = bindings.compareAndSet(draining, draining.withDrainReceipt(receipt)
                .withState(RuntimeBindingRecord.State.RELEASED, draining.getLease(), old));
        var session = runtimeSessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "prompt", "bootstrap", scope),
                retired.getBindingId(), retired.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, old));
        assertThat(runtimeSessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.RELEASED, old))).isNotNull();
        await().atMost(Duration.ofSeconds(5)).until(() -> !retired.getOperationLeaseUntil().isAfter(Instant.now()));
        return retired;
    }
}
