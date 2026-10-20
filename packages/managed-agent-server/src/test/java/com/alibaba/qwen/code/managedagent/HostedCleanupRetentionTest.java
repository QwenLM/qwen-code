package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedRuntimeRetentionGuard;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
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
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
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
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;

class HostedCleanupRetentionTest {
    private final ObjectMapper json = new ObjectMapper();
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
        source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]));
        runtimeSessions = new JdbcRuntimeSessionRepository(source);
        journal = transactions.execute(ignored -> new ExtensionRecordJournal(new ManagedSessionStore(jdbc),
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

    private void cleanup(String id, String prompt, String state) {
        CommitTransactionRequest request = cleanupRequest(id, prompt, state);
        transactions.executeWithoutResult(ignored -> journal.commit(request));
        journal.committed(request);
    }

    private CommitTransactionRequest cleanupRequest(String id, String prompt, String state) {
        ObjectNode body = json.createObjectNode().put("v", 1).put("promptId", prompt)
                .put("runtimeSessionId", prompt).put("bindingId", original.getBindingId())
                .put("generation", Long.toString(original.getGeneration())).put("workspaceGeneration", "1")
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
                }, records -> records);
        var resources = new java.util.ArrayList<>(template.resources());
        resources.add(descriptor);
        return new CommitTransactionRequest(template.workspaceId(), template.writerId(), template.writerGeneration(),
                template.expectedJournalRevision(), template.expectedCommittedSequence(), template.transactionId(),
                template.operation(), template.commandId(), template.contentDigest(), template.firstSequence(),
                template.lastSequence(), template.eventCount(), template.eventsDigest(), template.previousCommitDigest(),
                template.commitDigest(), template.activationEpoch(), template.latestCheckpointResourceId(),
                template.recordCount(), template.recordBytesBase64(), template.recordDigest(), resources);
    }

    private void assertCollected() {
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
