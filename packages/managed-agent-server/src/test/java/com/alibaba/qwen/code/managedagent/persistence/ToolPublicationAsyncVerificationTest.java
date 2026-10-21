package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationStorageException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.spy;

public class ToolPublicationAsyncVerificationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private PublicationJournalFixture fixture;
    private ToolPublicationDataStore data;
    private Bucket bucket;
    private JsonNode key;

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        fixture = PublicationJournalFixture.create(source, true);
        fixture.reserve();
        key = fixture.binding.path("sessionKey");
        bucket = new Bucket();
        data = replacement();
    }

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:async-publication-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        return source;
    }

    private ToolPublicationDataStore replacement() {
        return replacement(Duration.ofSeconds(10), Duration.ofSeconds(2));
    }

    private ToolPublicationDataStore replacement(Duration operationTimeout, Duration claimTimeout) {
        return new ToolPublicationDataStore(fixture.jdbc, fixture.manager, fixture.store, fixture.sessions, bucket,
                operationTimeout, claimTimeout,
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
    }

    private ToolPublicationVerifier manualVerifier(ToolPublicationDataStore store) {
        ToolPublicationVerifier verifier = new ToolPublicationVerifier(store, 2);
        store.setVerificationWakeup(() -> {});
        return verifier;
    }

    private JsonNode status(String operation) {
        return data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, operation);
    }

    private JsonNode publish(String operation, int ordinal, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        return data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, operation, "stdout", ordinal,
                bytes, ToolPublicationContract.sha256(bytes), true);
    }

    private void due(String operation) {
        fixture.jdbc.update("UPDATE ma_operation SET verification_next_at = " + ManagedSchemaTime.SQL_NOW + " WHERE operation_id = ?", operation);
    }

    private void blockRecovery(String recovery) {
        new TransactionTemplate(fixture.manager).executeWithoutResult(status ->
                assertThat(fixture.sessions.blockRecovery("tenant-1", "session-1", WRITER_TOKEN,
                        new ManagedSessionStoreModels.BlockRecoveryRequest("workspace-1", "writer-1", 1,
                                recovery, "test_recovery")).recoveryStatus()).isEqualTo(recovery));
    }

    private DataSource acceptCsiOperation() {
        DataSource source = dataSource();
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var registration = new WorkspaceCsiRegistration("tenant-1", "fixture-storage", "fixture-cluster",
                "fixture", "fixture-claim", "fixture-pvc", "fixture-volume", "fixture-pv",
                "fixture.csi", "fixture-handle", "fixture-backend", "fixture-serial", "/workspace", 1);
        fixture = PublicationJournalFixture.create(source, true, registration);
        fixture.reserve();
        fixture.store.verifyDispatch(fixture.executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN);
        var claim = fixture.executions.claimDispatch("execution-1", "dispatcher", Duration.ofMinutes(1));
        fixture.bindings.authorizeDispatch(new JdbcRuntimeSessionRepository(source), fixture.executions,
                claim, "dispatcher", claim.getDispatchGeneration());
        key = fixture.binding.path("sessionKey");
        data = replacement();
        assertThat(publish("csi", 0, "stored").path("state").asText()).isEqualTo("PENDING");
        return source;
    }

    @ParameterizedTest
    @ValueSource(strings = {"released", "registration"})
    void permanentCsiAuthorityLossLeavesTheQueueAndRemainsFailedAfterDeadline(String failure) {
        acceptCsiOperation();
        if (failure.equals("released")) {
            var runtime = fixture.bindings.findById("binding-1");
            assertThat(fixture.bindings.compareAndSet(runtime,
                    runtime.withState(RuntimeBindingRecord.State.RELEASED, runtime.getLease(), Instant.now())))
                    .isNotNull();
            assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot",
                    String.class)).isNull();
        } else {
            fixture.jdbc.update("UPDATE ma_storage SET registration_json = '{}'");
        }
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("csi").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("csi").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_runtime_unavailable");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        fixture.jdbc.update("UPDATE ma_operation SET deadline = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        assertThat(status("csi").path("state").asText()).isEqualTo("FAILED");
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(bucket.opens).hasValue(0);
    }

    @Test
    void settledCsiRetirementStillVerifiesAcceptedWork() {
        acceptCsiOperation();
        var registration = new WorkspaceCsiRegistration("tenant-1", "fixture-storage", "fixture-cluster",
                "fixture", "fixture-claim", "fixture-pvc", "fixture-volume", "fixture-pv",
                "fixture.csi", "fixture-handle", "fixture-backend", "fixture-serial", "/workspace", 1);
        new WorkspaceCsiReservationStore(fixture.jdbc, fixture.manager, JSON).beginRetirement(
                registration, fixture.bindings, fixture.bindings.findById("binding-1"),
                fixture.csiReservation, UUID.randomUUID().toString());
        var execution = fixture.executions.findByExecutionCallId("execution-1");
        assertThat(fixture.executions.compareAndSet(execution, execution.withResult(
                java.util.Map.of("executionStatus", "success"), execution.getLastSequence(), Instant.now()),
                "dispatcher", execution.getDispatchGeneration())).isNotNull();
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("csi").path("state").asText()).isEqualTo("SUCCEEDED");
    }

    @Test
    void missingReplicaCredentialKeyDoesNotBecomePermanentCsiFailure() {
        DataSource source = acceptCsiOperation();
        var bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("other-replica-key", new byte[32]));
        var grants = new ToolPublicationStore(fixture.jdbc, fixture.manager, fixture.sessions, fixture.executions,
                bindings, new ToolPublicationStore.Capacity(1024, 1024, 1024, 10), true);
        var other = new ToolPublicationDataStore(fixture.jdbc, fixture.manager, grants, fixture.sessions, bucket,
                Duration.ofSeconds(10), Duration.ofSeconds(2),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        assertThat(other.verifyNextOperation()).isTrue();
        assertThat(other.verifyNextOperation()).isFalse();
        assertThat(status("csi").path("state").asText()).isEqualTo("PENDING");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Boolean.class)).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT active_operation_id FROM ma_output_capture", String.class))
                .isEqualTo("csi");
        due("csi");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("csi").path("state").asText()).isEqualTo("SUCCEEDED");
    }

    @Test
    void unavailableReplicaKeyDoesNotKeepAnExpiredCandidateDue() {
        DataSource source = acceptCsiOperation();
        var bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("other-replica-key", new byte[32]));
        var grants = new ToolPublicationStore(fixture.jdbc, fixture.manager, fixture.sessions, fixture.executions,
                bindings, new ToolPublicationStore.Capacity(1024, 1024, 1024, 10), true);
        var other = new ToolPublicationDataStore(fixture.jdbc, fixture.manager, grants, fixture.sessions, bucket,
                Duration.ofSeconds(10), Duration.ofSeconds(2),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        fixture.jdbc.update("UPDATE ma_operation SET deadline = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        assertThat(other.verifyNextOperation()).isFalse();
        assertThat(status("csi").path("state").asText()).isEqualTo("EXPIRED");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        assertThat(fixture.jdbc.queryForObject("SELECT active_operation_id FROM ma_output_capture", String.class)).isNull();
        assertThat(bucket.opens).hasValue(0);
    }

    @ParameterizedTest
    @ValueSource(strings = {"null", "{"})
    void malformedCandidateInputsFailWithoutEscapingTheScan(String encoded) {
        publish("healthy", 0, "bytes");
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "bad-inputs", terminal(10), true);
        fixture.jdbc.update("UPDATE ma_operation SET verification_request_json = ?,"
                        + " verification_next_at = ? WHERE operation_id = X'6261642d696e70757473'",
                encoded.equals("null") ? null : encoded, Timestamp.valueOf("2000-01-01 00:00:00"));
        fixture.jdbc.update("UPDATE ma_operation SET verification_next_at = ?"
                        + " WHERE operation_id = X'6865616c746879'",
                Timestamp.valueOf("2000-01-02 00:00:00"));
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("bad-inputs").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("bad-inputs").path("error").path("code").asText()).isEqualTo("invalid_request");
        assertThat(status("healthy").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(bucket.opens).hasValue(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"segment", "inline-resource", "object-resource", "seal", "prefix", "inline-terminal", "object-terminal"})
    void acceptedInputsSurviveReplacementWithoutReposting(String kind) {
        if (kind.equals("seal") || kind.equals("prefix")) {
            data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0,
                    new byte[] {1, 2}, null);
            bucket.opens.set(0);
        }
        JsonNode response;
        if (kind.equals("segment")) {
            response = publish("accepted", 0, "stored");
        } else if (kind.endsWith("resource")) {
            response = data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "accepted", "content:test",
                    "managed-tool-result-content", new byte[kind.startsWith("inline") ? 10 : 70000], true);
        } else if (kind.equals("seal")) {
            response = data.seal(key, "pub-1", PUBLICATION_TOKEN, "accepted", "stdout", 1, 2,
                    ToolPublicationContract.sha256(new byte[] {1, 2}), true);
        } else if (kind.equals("prefix")) {
            response = data.prefix(key, "pub-1", PUBLICATION_TOKEN, "accepted", "stdout", true);
        } else {
            response = data.finish(key, "pub-1", PUBLICATION_TOKEN, "accepted",
                    terminal(kind.startsWith("object") ? 70000 : 10), true);
            assertThatThrownBy(() -> data.finished(key, "pub-1", WRITER_TOKEN)).hasMessageContaining("no finished");
        }
        assertThat(response.path("state").asText()).isEqualTo("PENDING");
        assertThat(status("accepted").path("state").asText()).isEqualTo("PENDING");
        assertThat(bucket.opens).hasValue(0);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'"
                + " AND operation_id = X'6163636570746564' AND capture_state = 'VERIFIED'", Integer.class)).isZero();
        data = replacement();
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("accepted").path("state").asText()).isEqualTo("SUCCEEDED");
        if (kind.endsWith("terminal")) {
            assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("terminal").path("digest").asText())
                    .isEqualTo(ToolPublicationContract.sha256(terminal(kind.startsWith("object") ? 70000 : 10)));
        }
    }

    @org.springframework.context.annotation.Configuration
    @org.springframework.scheduling.annotation.EnableScheduling
    @org.springframework.boot.context.properties.EnableConfigurationProperties(
            com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
    static class SchedulingHarness {}

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void springSchedulingDrainsAcceptedWorkEvenWithAdmissionDisabled(boolean asyncEnabled) {
        data = replacement(Duration.ofMinutes(5), Duration.ofSeconds(2));
        publish("restart", 0, "bytes");
        new org.springframework.boot.test.context.runner.ApplicationContextRunner()
                .withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(
                        com.alibaba.qwen.code.managedagent.config.AliyunToolPublicationStorageAutoConfiguration.class))
                .withUserConfiguration(SchedulingHarness.class,
                        com.alibaba.qwen.code.managedagent.config.ToolPublicationConfiguration.class)
                .withPropertyValues("qwen.managed-agent.tool-publication.enabled=true",
                        "qwen.managed-agent.tool-publication.service-base-url=https://test.invalid",
                        "qwen.managed-agent.tool-publication.async-verification-enabled=" + asyncEnabled,
                        "qwen.managed-agent.tool-publication.journal-head-authorization=true",
                        "qwen.managed-agent.tool-publication.execution-bytes=104857600",
                        "qwen.managed-agent.tool-publication.session-bytes=104857600",
                        "qwen.managed-agent.tool-publication.tenant-bytes=104857600",
                        "qwen.managed-agent.tool-publication.active-captures=10",
                        "qwen.managed-agent.tool-publication.entry-concurrency=2",
                        "qwen.managed-agent.tool-publication.verification-concurrency=3",
                        "qwen.managed-agent.tool-publication.operation-timeout=10s",
                        "qwen.managed-agent.tool-publication.claim-timeout=2s",
                        "qwen.managed-agent.tool-publication.max-verification-timeout=25m",
                        "qwen.managed-agent.tool-publication.verification-bytes-per-second=16777216")
                .withBean(org.springframework.jdbc.core.JdbcTemplate.class, () -> fixture.jdbc)
                .withBean(PlatformTransactionManager.class, () -> fixture.manager)
                .withBean(WriterCredentialPolicy.class, WriterCredentialPolicy::unbound)
                .withBean(ManagedSessionStore.class, () -> fixture.sessions)
                .withBean(com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository.class, () -> fixture.executions)
                .withBean(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class, () -> fixture.bindings)
                .withBean(org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder.class,
                        org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder::new)
                .withBean(ToolPublicationObjectStore.class, () -> bucket)
                .run(context -> {
                    assertThat(context).hasNotFailed().hasSingleBean(ToolPublicationVerifier.class)
                            .hasSingleBean(ToolPublicationDataStore.class).doesNotHaveBean(com.aliyun.oss.OSS.class);
                    var settings = context.getBean(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.class)
                            .getToolPublication();
                    assertThat(settings.isAsyncVerificationEnabled()).isEqualTo(asyncEnabled);
                    assertThat(settings.isJournalHeadAuthorization()).isTrue();
                    assertThat(settings.getVerificationConcurrency()).isEqualTo(3);
                    await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                            assertThat(status("restart").path("state").asText()).isEqualTo("SUCCEEDED"));
                });
    }

    @Test
    void readbackRunsOutsideTheRequestAndTransactionsWhilePutMustFinishFirst() throws Exception {
        bucket.blockPut = true;
        try (var requests = Executors.newSingleThreadExecutor()) {
            var request = requests.submit(() -> publish("blocked", 0, "bytes"));
            assertThat(bucket.putStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(request.isDone()).isFalse();
            bucket.putRelease.countDown();
            assertThat(request.get(5, TimeUnit.SECONDS).path("state").asText()).isEqualTo("PENDING");
        }
        bucket.blockOpen = 1;
        try (var verifier = manualVerifier(data); var workers = Executors.newSingleThreadExecutor()) {
            var verification = workers.submit(verifier::runOnce);
            assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(status("blocked").path("state").asText()).isEqualTo("PENDING");
            assertThat(verification.isDone()).isFalse();
            bucket.readRelease.countDown();
            assertThat(verification.get(5, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(status("blocked").path("state").asText()).isEqualTo("SUCCEEDED");
    }

    @Test
    void acceptanceWaitsForTheReadyTransactionToCommit() throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        PlatformTransactionManager manager = new PlatformTransactionManager() {
            @Override
            public TransactionStatus getTransaction(TransactionDefinition definition) {
                return fixture.manager.getTransaction(definition);
            }

            @Override
            public void commit(TransactionStatus transaction) {
                var values = fixture.jdbc.queryForList("SELECT verification_ready FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')"
                        + " AND operation_id = X'636f6d6d6974'", Boolean.class);
                if (values.size() == 1 && values.getFirst()) {
                    ready.countDown();
                    Bucket.await(release);
                }
                fixture.manager.commit(transaction);
            }

            @Override
            public void rollback(TransactionStatus transaction) {
                fixture.manager.rollback(transaction);
            }
        };
        ToolPublicationDataStore accepting = new ToolPublicationDataStore(fixture.jdbc, manager,
                fixture.store, fixture.sessions, bucket, Duration.ofSeconds(10), Duration.ofSeconds(2),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        try (var requests = Executors.newSingleThreadExecutor()) {
            var request = requests.submit(() -> accepting.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                    "commit", "stdout", 0, new byte[] {1}, null, true));
            try {
                assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(request.isDone()).isFalse();
                assertThat(bucket.puts).hasValue(1);
                assertThat(fixture.jdbc.queryForObject("SELECT verification_ready FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                        Boolean.class)).isFalse();
            } finally {
                release.countDown();
            }
            assertThat(request.get(5, TimeUnit.SECONDS).path("state").asText()).isEqualTo("PENDING");
            assertThat(fixture.jdbc.queryForObject("SELECT verification_ready FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                    Boolean.class)).isTrue();
        }
    }

    @Test
    void temporaryFailureKeepsThePrefixSlotAndRetriesWithoutReuploading() {
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0, new byte[] {1}, null);
        int puts = bucket.puts.get();
        data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stdout", true);
        bucket.failRead = true;
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
            assertThat(status("prefix").path("state").asText()).isEqualTo("PENDING");
            assertThat(verifier.runOnce()).isFalse();
            assertThatThrownBy(() -> publish("next", 1, "later"))
                    .isInstanceOf(ManagedAgentException.class).hasMessageContaining("busy");
            due("prefix");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("prefix").path("receipt").path("segmentCount").asInt()).isEqualTo(1);
        assertThat(bucket.puts).hasValue(puts);
    }

    @Test
    void permanentFailureRemainsTerminalAndSameRequestDoesNotReviveIt() {
        publish("bad", 0, "bytes");
        bucket.objects.values().iterator().next()[0] = 'x';
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("bad").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("bad").path("error").path("code").asText()).isEqualTo("invalid_request");
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo("QUARANTINED");
        fixture.jdbc.update("UPDATE ma_operation SET deadline = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        assertThat(status("bad").path("state").asText()).isEqualTo("FAILED");
        assertThat(publish("bad", 0, "bytes").path("state").asText()).isEqualTo("FAILED");
        assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "bad"))
                .hasMessageContaining("cannot be recovered");
        assertThat(bucket.puts).hasValue(1);
        assertThat(fixture.jdbc.queryForObject("SELECT capture_used_bytes FROM ma_output_capture", Long.class))
                .isEqualTo(5);
    }

    @Test
    void permanentFailureReleasesItsSlotBeforeItsDeadline() {
        publish("denied", 0, "bytes");
        bucket.readFailure = new ToolPublicationStorageException(ToolPublicationStorageException.Reason.ACCESS_DENIED,
                new IllegalStateException("denied"));
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("denied").path("state").asText()).isEqualTo("FAILED");
        assertThat(publish("next", 1, "later").path("state").asText()).isEqualTo("PENDING");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("next").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(status("denied").path("state").asText()).isEqualTo("FAILED");
    }

    @ParameterizedTest
    @CsvSource({"true,managed_tool_publication_busy", "false,managed_tool_publication_busy",
            "true,managed_tool_publication_claim_lost", "false,managed_tool_publication_claim_lost",
            "true,managed_tool_publication_claim_expired", "false,managed_tool_publication_claim_expired",
            "true,managed_tool_publication_operation_expired", "false,managed_tool_publication_operation_expired"})
    void transientVerificationErrorsRetryBeforeAndAfterClaim(boolean beforeClaim, String code) {
        data = replacement(Duration.ofMinutes(5), Duration.ofSeconds(2));
        publish("retry", 0, "bytes");
        var error = new ManagedAgentException(HttpStatus.CONFLICT, code, "Temporary contention");
        if (beforeClaim) {
            var grants = spy(fixture.store);
            doThrow(error).doCallRealMethod().when(grants)
                    .producerVerificationBindingLocked(anyString(), anyString(), anyString(), anyString());
            data = new ToolPublicationDataStore(fixture.jdbc, fixture.manager, grants, fixture.sessions, bucket,
                    Duration.ofMinutes(5), Duration.ofSeconds(2),
                    new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        } else {
            bucket.readFailure = error;
        }
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("retry").path("state").asText()).isEqualTo("PENDING");
        assertThat(fixture.jdbc.queryForObject("SELECT active_operation_id FROM ma_output_capture", String.class))
                .isEqualTo("retry");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNotNull();
        // The deferral lands about a second out; pin it further ahead so the
        // not-yet-due rescan cannot lose that race on a loaded runner.
        assertThat(fixture.jdbc.update("UPDATE ma_operation SET verification_next_at = ?"
                + " WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND operation_id = ?",
                Timestamp.valueOf("2100-01-01 00:00:00"), "retry")).isOne();
        assertThat(data.verifyNextOperation()).isFalse();
        due("retry");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("retry").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void unclassifiedReadFailureCannotCertifyCorruption() {
        publish("retry", 0, "healthy");
        byte[] bytes = bucket.objects.values().iterator().next().clone();
        bucket.readFailure = new IllegalArgumentException("Unclassified storage read failure");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("retry").path("state").asText()).isEqualTo("PENDING");
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo("CANDIDATE");
        assertThat(bucket.objects.values().iterator().next()).isEqualTo(bytes);
        due("retry");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("retry").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void recoveryBlockDuringReadFailsWithoutQuarantiningHealthyCandidate() {
        data = replacement(Duration.ofMinutes(2), Duration.ofSeconds(3));
        byte[] bytes = "h".repeat(70000).getBytes(StandardCharsets.US_ASCII);
        data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "resource", "content:test",
                "managed-tool-result-content", bytes, true);
        bucket.midRead = () -> blockRecovery("BLOCKED_EXECUTION");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(bucket.opens).hasValue(1);
        assertThat(fixture.jdbc.queryForObject("SELECT recovery_status FROM ma_session_head",
                String.class)).isEqualTo("BLOCKED_EXECUTION");
        assertThat(status("resource").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("resource").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_fenced");
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo("CANDIDATE");
        assertThat(fixture.jdbc.queryForObject("SELECT sha256 FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo(ToolPublicationContract.sha256(bytes));
        assertThat(bucket.objects.values().iterator().next()).isEqualTo(bytes);
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(status("resource").path("state").asText()).isEqualTo("FAILED");
        assertThat(bucket.puts).hasValue(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"BLOCKED_EXECUTION", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE"})
    void recoveryBlockBeforeClaimFailsWithoutReadingHealthyCandidate(String recovery) {
        byte[] bytes = "h".repeat(70000).getBytes(StandardCharsets.US_ASCII);
        data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "resource", "content:test",
                "managed-tool-result-content", bytes, true);
        blockRecovery(recovery);
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("resource").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("resource").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_fenced");
        assertThat(bucket.opens).hasValue(0);
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo("CANDIDATE");
        assertThat(bucket.objects.values().iterator().next()).isEqualTo(bytes);
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(status("resource").path("state").asText()).isEqualTo("FAILED");
    }

    @ParameterizedTest
    @ValueSource(strings = {"BLOCKED_EXECUTION", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE"})
    void recoveryBlockBeforeClaimPermanentlyFailsAcceptedTerminal(String recovery) {
        byte[] bytes = terminal(70000);
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", bytes, true);
        blockRecovery(recovery);
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("finish").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("finish").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_fenced");
        assertThat(bucket.opens).hasValue(0);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", Integer.class))
                .isZero();
        assertThat(fixture.jdbc.queryForObject("SELECT producer_used_bytes FROM ma_output_capture", Long.class))
                .isZero();
        assertThat(bucket.objects).isEmpty();
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(status("finish").path("state").asText()).isEqualTo("FAILED");
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void lostSlotBeforeClaimCanRetryAfterTheSlotIsRestored() {
        publish("slot", 0, "bytes");
        fixture.jdbc.update("UPDATE ma_output_capture SET active_operation_id = X'6f74686572'");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("slot").path("state").asText()).isEqualTo("PENDING");
        assertThat(bucket.opens).hasValue(0);
        fixture.jdbc.update("UPDATE ma_output_capture SET active_operation_id = X'736c6f74'");
        due("slot");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("slot").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(bucket.puts).hasValue(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"temporary", "denied"})
    void expiredAttemptDefersInsteadOfImmediatelyReclaiming(String failure) throws Exception {
        publish("retry", 0, "bytes");
        bucket.blockOpen = 1;
        if (failure.equals("denied")) {
            bucket.readFailure = new ToolPublicationStorageException(ToolPublicationStorageException.Reason.ACCESS_DENIED,
                    new IllegalStateException("denied"));
        } else {
            bucket.failRead = true;
        }
        try (var verifier = manualVerifier(data); var worker = Executors.newSingleThreadExecutor()) {
            var attempt = worker.submit(verifier::runOnce);
            assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
            fixture.jdbc.update("UPDATE ma_operation SET claim_until = ?, verification_next_at = ?",
                    Timestamp.valueOf("2000-01-01 00:00:00"), Timestamp.valueOf("2000-01-01 00:00:00"));
            bucket.readRelease.countDown();
            assertThat(attempt.get(5, TimeUnit.SECONDS)).isTrue();
            assertThat(status("retry").path("state").asText()).isEqualTo("PENDING");
            assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at > " + ManagedSchemaTime.SQL_NOW + " FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Boolean.class)).isTrue();
            assertThat(verifier.runOnce()).isFalse();
            assertThatThrownBy(() -> publish("next", 1, "later")).hasMessageContaining("busy");
            due("retry");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("retry").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void storageDenialIsPermanentAndDoesNotExposeStorageDetails() {
        publish("denied", 0, "bytes");
        bucket.readFailure = new ToolPublicationStorageException(ToolPublicationStorageException.Reason.ACCESS_DENIED,
                new IllegalStateException("private backend diagnostics"));
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
            assertThat(verifier.runOnce()).isFalse();
        }
        JsonNode failure = status("denied");
        assertThat(failure.path("state").asText()).isEqualTo("FAILED");
        assertThat(failure.path("error").path("status").asInt()).isEqualTo(403);
        assertThat(failure.path("error").path("code").asText()).isEqualTo("managed_tool_publication_storage_denied");
        assertThat(failure.toString()).doesNotContain("private");
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void expiredQueueRecoversTheOriginalInputsWithoutChangingItsFirstDeadline() {
        publish("expired", 0, "bytes");
        Timestamp original = Timestamp.valueOf("2000-01-01 00:00:00");
        fixture.jdbc.update("UPDATE ma_operation SET deadline = ?", original);
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isFalse();
            assertThat(status("expired").path("state").asText()).isEqualTo("EXPIRED");
            assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                    Timestamp.class)).isNull();
            data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "expired");
            assertThat(status("expired").path("state").asText()).isEqualTo("PENDING");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("expired").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(fixture.jdbc.queryForObject("SELECT deadline FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Timestamp.class))
                .isEqualTo(original);
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void expiredPrefixCannotRecoverAndSealRecoveryRejectsAddedSegments() {
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0, new byte[] {1}, null);
        data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stdout", true);
        fixture.jdbc.update("UPDATE ma_operation SET deadline = ? WHERE operation_id = X'707265666978'",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        try (var verifier = manualVerifier(data)) {
            verifier.runOnce();
            assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "prefix"))
                    .hasMessageContaining("prefix cannot be recovered");
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal", "stdout", 1, 1,
                    ToolPublicationContract.sha256(new byte[] {1}), true);
            fixture.jdbc.update("UPDATE ma_operation SET deadline = ? WHERE operation_id = X'7365616c'",
                    Timestamp.valueOf("2000-01-01 00:00:00"));
            verifier.runOnce();
            data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "extra", "stdout", 1, new byte[] {2}, null);
            data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "seal");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("seal").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("seal").path("error").path("code").asText()).isEqualTo("managed_tool_result_conflict");
    }

    @Test
    void leaseTakeoverFencesLateCorruptionAndCompletion() throws Exception {
        data = replacement(Duration.ofMinutes(2), Duration.ofMinutes(1));
        publish("takeover", 0, "bytes");
        bucket.blockOpen = 1;
        try (var first = manualVerifier(data); var second = manualVerifier(replacement(Duration.ofMinutes(2), Duration.ofMinutes(1)));
                var workers = Executors.newSingleThreadExecutor()) {
            var old = workers.submit(first::runOnce);
            assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
            long firstEpoch = fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Long.class);
            due("takeover");
            assertThat(second.runOnce()).isFalse();
            assertThat(fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Long.class))
                    .isEqualTo(firstEpoch);
            fixture.jdbc.update("UPDATE ma_operation SET claim_until = ?, verification_next_at = ?",
                    Timestamp.valueOf("2000-01-01 00:00:00"), Timestamp.valueOf("2000-01-01 00:00:00"));
            assertThat(second.runOnce()).isTrue();
            long epoch = fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Long.class);
            bucket.objects.values().iterator().next()[0] = 'x';
            bucket.readRelease.countDown();
            assertThat(old.get(5, TimeUnit.SECONDS)).isTrue();
            assertThat(fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Long.class))
                    .isEqualTo(epoch);
        }
        assertThat(status("takeover").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                .isEqualTo("VERIFIED");
    }

    @Test
    void staleCorruptReadCannotQuarantineTheSuccessorsCandidate() throws Exception {
        data = replacement(Duration.ofMinutes(2), Duration.ofMinutes(1));
        publish("takeover", 0, "bytes");
        bucket.blockOpen = 1;
        bucket.corruptBlockedRead = true;
        bucket.blockSuccessor = true;
        try (var first = manualVerifier(data); var second = manualVerifier(replacement(Duration.ofMinutes(2), Duration.ofMinutes(1)));
                var workers = Executors.newFixedThreadPool(2)) {
            var old = workers.submit(first::runOnce);
            try {
                assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
                fixture.jdbc.update("UPDATE ma_operation SET claim_until = ?, verification_next_at = ?",
                        Timestamp.valueOf("2000-01-01 00:00:00"), Timestamp.valueOf("2000-01-01 00:00:00"));
                var successor = workers.submit(second::runOnce);
                try {
                    assertThat(bucket.successorStarted.await(5, TimeUnit.SECONDS)).isTrue();
                    bucket.readRelease.countDown();
                    assertThat(old.get(5, TimeUnit.SECONDS)).isTrue();
                    assertThat(status("takeover").path("state").asText()).isEqualTo("PENDING");
                    assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                            .isEqualTo("CANDIDATE");
                    assertThat(fixture.jdbc.queryForObject("SELECT quarantined FROM ma_output_capture", Boolean.class)).isFalse();
                } finally {
                    bucket.successorRelease.countDown();
                }
                assertThat(successor.get(5, TimeUnit.SECONDS)).isTrue();
            } finally {
                bucket.readRelease.countDown();
                bucket.successorRelease.countDown();
            }
        }
        assertThat(status("takeover").path("state").asText()).isEqualTo("SUCCEEDED");
    }

    @ParameterizedTest
    @ValueSource(strings = {"seal", "prefix"})
    void staleCorruptScanCannotQuarantineTheSuccessorsPublication(String scan) throws Exception {
        data = replacement(Duration.ofMinutes(2), Duration.ofMinutes(1));
        byte[] bytes = new byte[] {1, 2};
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0, bytes, null);
        bucket.opens.set(0);
        if (scan.equals("seal")) {
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "takeover", "stdout", 1, bytes.length,
                    ToolPublicationContract.sha256(bytes), true);
        } else {
            data.prefix(key, "pub-1", PUBLICATION_TOKEN, "takeover", "stdout", true);
        }
        bucket.blockOpen = 1;
        bucket.corruptBlockedRead = true;
        bucket.blockSuccessor = true;
        try (var first = manualVerifier(data); var second = manualVerifier(replacement(Duration.ofMinutes(2), Duration.ofMinutes(1)));
                var workers = Executors.newFixedThreadPool(2)) {
            var old = workers.submit(first::runOnce);
            try {
                assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
                long oldEpoch = fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')"
                        + " AND operation_id = X'74616b656f766572'", Long.class);
                fixture.jdbc.update("UPDATE ma_operation SET claim_until = ?, verification_next_at = ?"
                                + " WHERE operation_id = X'74616b656f766572'",
                        Timestamp.valueOf("2000-01-01 00:00:00"), Timestamp.valueOf("2000-01-01 00:00:00"));
                var successor = workers.submit(second::runOnce);
                try {
                    assertThat(bucket.successorStarted.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThat(fixture.jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')"
                            + " AND operation_id = X'74616b656f766572'", Long.class)).isEqualTo(oldEpoch + 1);
                    bucket.readRelease.countDown();
                    assertThat(old.get(5, TimeUnit.SECONDS)).isTrue();
                    assertThat(status("takeover").path("state").asText()).isEqualTo("PENDING");
                    assertThat(fixture.jdbc.queryForObject("SELECT quarantined FROM ma_output_capture", Boolean.class)).isFalse();
                    assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'", String.class))
                            .isEqualTo("VERIFIED");
                } finally {
                    bucket.successorRelease.countDown();
                }
                assertThat(successor.get(5, TimeUnit.SECONDS)).isTrue();
            } finally {
                bucket.readRelease.countDown();
                bucket.successorRelease.countDown();
            }
        }
        assertThat(status("takeover").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(status("takeover").path("receipt").path("segmentCount").asInt()).isEqualTo(1);
        assertThat(status("takeover").path("receipt").path("digest").asText())
                .isEqualTo(ToolPublicationContract.sha256(bytes));
    }

    @Test
    void historicalReplayDoesNotReadAndAnotherIdForTheSameSlotCompletesDirectly() {
        publish("original", 0, "bytes");
        try (var verifier = manualVerifier(data)) {
            verifier.runOnce();
        }
        int reads = bucket.opens.get();
        assertThat(publish("original", 0, "bytes").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(publish("alias", 0, "bytes").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(bucket.opens).hasValue(reads);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Integer.class))
                .isEqualTo(1);
        bucket.objects.values().iterator().next()[0] = 'x';
        assertThat(publish("original", 0, "bytes").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThatThrownBy(() -> data.prefix(key, "pub-1", PUBLICATION_TOKEN, "actual-read", "stdout"))
                .hasMessageContaining("digest changed");
        assertThatThrownBy(() -> publish("original", 0, "bytes")).hasMessageContaining("quarantined");
    }

    @Test
    void executionModeIsStickyAcrossCapabilityChangesAndIncompletePuts() {
        bucket.failPut = true;
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "sync", "stdout", 0,
                new byte[] {1}, null)).hasMessageContaining("Unknown PUT result");
        assertThat(fixture.jdbc.queryForObject("SELECT execution_mode FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                String.class)).isEqualTo("SYNC");
        assertThat(status("sync").path("state").asText()).isEqualTo("RETRYABLE");
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "sync", "stdout", 0,
                new byte[] {1}, null, true).has("state")).isFalse();
        assertThat(bucket.puts).hasValue(1);
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'OBJECT_PUT'",
                String.class)).isEqualTo("RETURNED");
        assertThat(fixture.jdbc.queryForObject("SELECT execution_mode FROM ma_operation WHERE operation_kind IN"
                + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", String.class)).isEqualTo("SYNC");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isFalse();
        }
    }

    @Test
    void configuredVerifierWakesOnCommitAndScansAcceptedWorkAfterReplacement() {
        try (var verifier = new ToolPublicationVerifier(data, 2)) {
            publish("wake", 0, "first");
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                    assertThat(status("wake").path("state").asText()).isEqualTo("SUCCEEDED"));
        }
        publish("restart", 1, "second");
        data = replacement();
        try (var verifier = new ToolPublicationVerifier(data, 2)) {
            verifier.wake();
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                    assertThat(status("restart").path("state").asText()).isEqualTo("SUCCEEDED"));
        }
    }

    @Test
    void lapsedActivationDefersAcceptedWorkUntilItIsRenewed() {
        publish("lapse", 0, "bytes");
        Number expires = fixture.jdbc.queryForObject(
                "SELECT activation_expires_at FROM ma_session_head", Number.class);
        Number grant = fixture.jdbc.queryForObject(
                "SELECT expires_at FROM ma_output_capture", Number.class);
        assertThat(expires).isNotNull();
        assertThat(grant).isNotNull();
        fixture.jdbc.update("UPDATE ma_session_head SET activation_expires_at = ?", 1L);
        fixture.jdbc.update("UPDATE ma_output_capture SET expires_at = ?", 1L);
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("lapse").path("state").asText()).isEqualTo("PENDING");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at IS NOT NULL"
                + " FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND operation_id = X'6c61707365'", Boolean.class)).isTrue();
        fixture.jdbc.update("UPDATE ma_session_head SET activation_expires_at = ?",
                expires.longValue());
        fixture.jdbc.update("UPDATE ma_output_capture SET expires_at = ?", grant.longValue());
        due("lapse");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("lapse").path("state").asText()).isEqualTo("SUCCEEDED");
    }

    @Test
    void failedFinishReleasesThePublicationForALaterFinish() {
        publish("segment", 0, "bytes");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        byte[] body = terminal(10);
        assertThat(data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", body, true).path("state").asText())
                .isEqualTo("PENDING");
        fixture.jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE slot_key = X'7465726d696e616c'",
                new byte[] {1});
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("finish").path("state").asText()).isEqualTo("FAILED");
        assertThat(fixture.jdbc.queryForObject("SELECT producer_phase FROM ma_output_capture", String.class))
                .isEqualTo("OPEN");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'"
                + " AND slot_key = X'7465726d696e616c'", Integer.class)).isZero();
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'"
                + " AND capture_state <> 'VERIFIED'", Integer.class)).isZero();
        assertThat(data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish-2", body, true).path("state").asText())
                .isEqualTo("PENDING");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("finish-2").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(status("finish").path("state").asText()).isEqualTo("FAILED");
    }

    @ParameterizedTest
    @CsvSource({"lease,READY", "takeover,READY", "lease,BLOCKED_EXECUTION", "takeover,BLOCKED_EXECUTION"})
    void fencedAcceptedWorkFailsWithoutReadingAndStatusDoesNotReviveOrRenewIt(String cause, String recovery) {
        publish("fenced", 0, "bytes");
        fixture.jdbc.update("UPDATE ma_session_head SET recovery_status = ?", recovery);
        Timestamp deadline = fixture.jdbc.queryForObject("SELECT deadline FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class);
        Timestamp expired = Timestamp.valueOf("2000-01-01 00:00:00");
        fixture.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?", expired);
        fixture.jdbc.update("UPDATE ma_output_capture SET expires_at = ?", expired.getTime());
        if ("takeover".equals(cause)) {
            fixture.jdbc.update("UPDATE ma_session_head SET writer_id = 'other',"
                    + " writer_generation = writer_generation + 1, writer_lease_until = ?",
                    new Timestamp(System.currentTimeMillis() + 60000));
        }
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("fenced").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("fenced").path("error").path("code").asText()).isEqualTo("managed_tool_publication_fenced");
        assertThat(bucket.opens).hasValue(0);
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')",
                Timestamp.class)).isNull();
        for (int i = 0; i < 10; i++) {
            status("fenced");
        }
        assertThat(fixture.jdbc.queryForObject("SELECT deadline FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Timestamp.class))
                .isEqualTo(deadline);
        assertThat(publish("fenced", 0, "bytes").path("state").asText()).isEqualTo("FAILED");
        String otherToken = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("x".repeat(32).getBytes(StandardCharsets.US_ASCII));
        assertThatThrownBy(() -> data.operationStatus(key, "pub-1", otherToken, "fenced"))
                .hasMessageContaining("scope conflicts");
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "extra", "digest"})
    void sealValidationFailuresNeverInstallASeal(String damage) {
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0, new byte[] {1}, null);
        int count = damage.equals("missing") ? 2 : damage.equals("extra") ? 0 : 1;
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "bad-seal", "stdout", count, 1,
                ToolPublicationContract.sha256(new byte[] {2}), true);
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("bad-seal").path("state").asText()).isEqualTo("FAILED");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture WHERE seal_manifest_resource_key IS NOT NULL", Integer.class))
                .isZero();
    }

    @ParameterizedTest
    @CsvSource({"false,false", "true,false", "false,true"})
    void finishVerifiesTheCompleteCaptureAndRejectsChangedManifestIdentity(boolean invalid, boolean readFailure) {
        byte[] bytes = new byte[] {1, 2};
        String digest = ToolPublicationContract.sha256(bytes);
        try (var verifier = manualVerifier(data)) {
            publish("segment", 0, new String(bytes, StandardCharsets.UTF_8));
            verifier.runOnce();
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-out", "stdout", 1, 2, digest, true);
            verifier.runOnce();
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-err", "stderr", 0, 0,
                    ToolPublicationContract.sha256(new byte[0]), true);
            verifier.runOnce();
            ObjectNode page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                    .put("type", "page").put("captureId", "capture-1").put("streamId", "stdout")
                    .put("firstOrdinal", 0).put("offset", 0);
            page.putArray("segments").add(JSON.createObjectNode().put("byteLength", 2).put("digest", digest));
            data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "page", "page:stdout:0",
                    "managed-tool-result-page", page.toString().getBytes(StandardCharsets.UTF_8), true);
            verifier.runOnce();
            ObjectNode manifest = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                    .put("type", "manifest").put("tenantId", invalid ? "wrong" : "tenant-1")
                    .put("sessionId", "session-1").put("turnId", "turn-1").put("executionCallId", "execution-1")
                    .put("callId", "runtime-call-1").put("bindingGeneration", "1").put("captureId", "capture-1")
                    .put("invocationDigest", fixture.binding.path("reference").path("argsDigest").asText())
                    .put("revision", 1).put("executionStatus", "success").put("exitCode", 0).putNull("signal")
                    .put("captureScope", "process_pipes").put("capturePolicy", "complete_required")
                    .put("captureStatus", "complete").putNull("captureReason").put("upstreamTruncated", false);
            var contents = manifest.putArray("contents");
            for (String stream : new String[] {"stdout", "stderr"}) {
                ObjectNode content = JSON.createObjectNode().put("streamId", stream).put("role", stream)
                        .put("mimeType", "application/octet-stream").put("state", "sealed")
                        .put("byteLength", stream.equals("stdout") ? 2 : 0)
                        .put("digest", stream.equals("stdout") ? digest : ToolPublicationContract.sha256(new byte[0]));
                content.putArray("missingRanges");
                var pages = content.putObject("body").putArray("pages");
                if (stream.equals("stdout")) {
                    ObjectNode link = JSON.createObjectNode().put("segmentCount", 1).put("byteLength", 2);
                    link.set("ref", status("page").path("receipt"));
                    pages.add(link);
                }
                contents.add(content);
            }
            data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "manifest", "manifest:1",
                    "managed-tool-result-manifest", manifest.toString().getBytes(StandardCharsets.UTF_8), true);
            verifier.runOnce();
            ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
            envelope.putArray("responseParts");
            ObjectNode capture = envelope.putObject("capture").put("captureStatus", "complete")
                    .putNull("captureReason").put("previewTruncated", false).put("deliveryStatus", "pending");
            capture.set("manifest", status("manifest").path("receipt"));
            data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish",
                    envelope.toString().getBytes(StandardCharsets.UTF_8), true);
            bucket.opens.set(0);
            if (readFailure) {
                bucket.readFailure = new IllegalArgumentException("Unclassified capture read failure");
            }
            assertThat(verifier.runOnce()).isTrue();
            if (readFailure) {
                assertThat(status("finish").path("state").asText()).isEqualTo("PENDING");
                assertThat(fixture.jdbc.queryForObject("SELECT producer_phase FROM ma_output_capture", String.class))
                        .isEqualTo("FINISHING");
                assertThat(fixture.jdbc.queryForObject("SELECT capture_state FROM ma_resource WHERE publication_id IS NOT NULL AND kind <> X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374'"
                        + " AND slot_key = X'7465726d696e616c'", String.class)).isEqualTo("CANDIDATE");
                assertThat(fixture.jdbc.queryForObject("SELECT producer_used_bytes FROM ma_output_capture", Long.class))
                        .isPositive();
                due("finish");
                assertThat(verifier.runOnce()).isTrue();
            }
            assertThat(status("finish").path("state").asText()).isEqualTo(invalid ? "FAILED" : "SUCCEEDED");
            if (!invalid) {
                assertThat(bucket.opens.get()).isPositive();
                assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
            }
        }
    }

    @Test
    void finishWaitsForItsPredecessorAndFailsWhenThePredecessorFails() {
        publish("predecessor", 0, "bytes");
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", terminal(10), true);
        bucket.objects.values().iterator().next()[0] = 'x';
        fixture.jdbc.update("UPDATE ma_operation SET verification_next_at = deadline"
                + " WHERE operation_id = ?", "predecessor");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
            assertThat(status("predecessor").path("state").asText()).isEqualTo("PENDING");
            assertThat(status("finish").path("state").asText()).isEqualTo("PENDING");
            assertThatThrownBy(() -> data.finished(key, "pub-1", WRITER_TOKEN)).hasMessageContaining("no finished");
            fixture.jdbc.update("UPDATE ma_operation SET verification_next_at = deadline"
                    + " WHERE operation_id = ?", "finish");
            due("predecessor");
            assertThat(verifier.runOnce()).isTrue();
            assertThat(status("predecessor").path("state").asText()).isEqualTo("FAILED");
            due("finish");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("finish").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("finish").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_predecessor_failed");
        assertThatThrownBy(() -> data.finished(key, "pub-1", WRITER_TOKEN)).hasMessageContaining("no finished");
    }

    private static byte[] terminal(int textLength) {
        var result = JSON.createObjectNode().put("executionStatus", "success");
        result.putArray("responseParts").add("x".repeat(textLength));
        result.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        return (" " + result).getBytes(StandardCharsets.UTF_8);
    }

    private static final class Bucket implements ToolPublicationObjectStore {
        private final Map<String, byte[]> objects = new ConcurrentHashMap<>();
        private final AtomicInteger puts = new AtomicInteger();
        private final AtomicInteger opens = new AtomicInteger();
        private final CountDownLatch putStarted = new CountDownLatch(1);
        private final CountDownLatch putRelease = new CountDownLatch(1);
        private final CountDownLatch readStarted = new CountDownLatch(1);
        private final CountDownLatch readRelease = new CountDownLatch(1);
        private final CountDownLatch successorStarted = new CountDownLatch(1);
        private final CountDownLatch successorRelease = new CountDownLatch(1);
        private boolean corruptBlockedRead;
        private boolean blockSuccessor;
        private boolean blockPut;
        private int blockOpen;
        private boolean failRead;
        private boolean failPut;
        private RuntimeException readFailure;
        private Runnable midRead;

        @Override
        public void putIfAbsent(String objectKey, byte[] bytes) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            puts.incrementAndGet();
            putStarted.countDown();
            if (blockPut) {
                await(putRelease);
            }
            objects.putIfAbsent(objectKey, bytes.clone());
            if (failPut) {
                failPut = false;
                throw new IllegalStateException("Unknown PUT result");
            }
        }

        @Override
        public InputStream open(String objectKey) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            int read = opens.incrementAndGet();
            byte[] bytes = objects.get(objectKey);
            if (read == blockOpen) {
                if (corruptBlockedRead) {
                    bytes = bytes.clone();
                    bytes[0] = 'x';
                }
                readStarted.countDown();
                await(readRelease);
            } else if (blockSuccessor && read == 2) {
                successorStarted.countDown();
                await(successorRelease);
            }
            if (failRead) {
                failRead = false;
                throw new IllegalStateException("Temporary read failure");
            }
            if (readFailure != null) {
                RuntimeException failure = readFailure;
                readFailure = null;
                throw failure;
            }
            return new ByteArrayInputStream(bytes) {
                private int reads;

                @Override
                public synchronized int read(byte[] target, int offset, int length) {
                    if (++reads == 2 && midRead != null) {
                        midRead.run();
                        midRead = null;
                        try {
                            Thread.sleep(1100);
                        } catch (InterruptedException error) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException(error);
                        }
                    }
                    return super.read(target, offset, length);
                }
            };
        }

        @Override
        public void validateConfiguration() {}

        @Override
        public void deleteIfPresent(String key) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            objects.remove(key);
        }

        private static void await(CountDownLatch latch) {
            try {
                if (!latch.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Test latch timed out");
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
            }
        }
    }
}
