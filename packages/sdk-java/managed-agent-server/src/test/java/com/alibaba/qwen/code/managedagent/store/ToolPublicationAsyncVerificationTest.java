package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;

public class ToolPublicationAsyncVerificationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private PublicationJournalFixture fixture;
    private ToolPublicationDataStore data;
    private Bucket bucket;
    private JsonNode key;

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        Flyway.configure().dataSource(source).load().migrate();
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
        return new ToolPublicationDataStore(fixture.jdbc, fixture.manager, fixture.store, fixture.sessions, bucket,
                Duration.ofSeconds(10), Duration.ofSeconds(2),
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
        fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET verification_next_at = CURRENT_TIMESTAMP(6)"
                + " WHERE operation_id = ?", operation);
    }

    private DataSource acceptCsiOperation() {
        DataSource source = dataSource();
        Flyway.configure().dataSource(source).load().migrate();
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
            assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM qwen_runtime_binding_slot",
                    String.class)).isNull();
        } else {
            fixture.jdbc.update("UPDATE managed_workspace_csi_registration SET registration_json = '{}'");
        }
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("csi").path("state").asText()).isEqualTo("FAILED");
        assertThat(status("csi").path("error").path("code").asText())
                .isEqualTo("managed_tool_publication_runtime_unavailable");
        assertThat(fixture.jdbc.queryForObject("SELECT verification_next_at FROM qwen_tool_publication_operation",
                Timestamp.class)).isNull();
        fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET deadline = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        assertThat(status("csi").path("state").asText()).isEqualTo("FAILED");
        assertThat(data.verifyNextOperation()).isFalse();
        assertThat(bucket.opens).hasValue(0);
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
        assertThatThrownBy(other::verifyNextOperation).isInstanceOf(IllegalStateException.class)
                .hasMessage("Runtime credential key is unavailable").hasNoCause();
        assertThat(status("csi").path("state").asText()).isEqualTo("PENDING");
        assertThat(data.verifyNextOperation()).isTrue();
        assertThat(status("csi").path("state").asText()).isEqualTo("SUCCEEDED");
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
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object"
                + " WHERE operation_id = 'accepted' AND state = 'VERIFIED'", Integer.class)).isZero();
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
                var values = fixture.jdbc.queryForList("SELECT verification_ready FROM qwen_tool_publication_operation"
                        + " WHERE operation_id = 'commit'", Boolean.class);
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
                assertThat(fixture.jdbc.queryForObject("SELECT verification_ready FROM qwen_tool_publication_operation",
                        Boolean.class)).isFalse();
            } finally {
                release.countDown();
            }
            assertThat(request.get(5, TimeUnit.SECONDS).path("state").asText()).isEqualTo("PENDING");
            assertThat(fixture.jdbc.queryForObject("SELECT verification_ready FROM qwen_tool_publication_operation",
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
            assertThatThrownBy(() -> publish("next", 1, "later"))
                    .isInstanceOf(ApiException.class).hasMessageContaining("busy");
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
        fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET deadline = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        assertThat(status("bad").path("state").asText()).isEqualTo("FAILED");
        assertThat(publish("bad", 0, "bytes").path("state").asText()).isEqualTo("FAILED");
        assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "bad"))
                .hasMessageContaining("cannot be recovered");
        assertThat(bucket.puts).hasValue(1);
        assertThat(fixture.jdbc.queryForObject("SELECT capture_used_bytes FROM qwen_tool_publication", Long.class))
                .isEqualTo(5);
    }

    @Test
    void storageDenialIsPermanentAndDoesNotExposeStorageDetails() {
        publish("denied", 0, "bytes");
        bucket.readFailure = new com.aliyun.oss.OSSException("private storage message", "AccessDenied",
                "private-request", "private-host", "private-bucket", "private-key", "private-resource");
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
        fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET deadline = ?", original);
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isFalse();
            assertThat(status("expired").path("state").asText()).isEqualTo("EXPIRED");
            data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "expired");
            assertThat(status("expired").path("state").asText()).isEqualTo("PENDING");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("expired").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(fixture.jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation", Timestamp.class))
                .isEqualTo(original);
        assertThat(bucket.puts).hasValue(1);
    }

    @Test
    void expiredPrefixCannotRecoverAndSealRecoveryRejectsAddedSegments() {
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "seed", "stdout", 0, new byte[] {1}, null);
        data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stdout", true);
        fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET deadline = ? WHERE operation_id = 'prefix'",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        try (var verifier = manualVerifier(data)) {
            verifier.runOnce();
            assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "prefix"))
                    .hasMessageContaining("prefix cannot be recovered");
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal", "stdout", 1, 1,
                    ToolPublicationContract.sha256(new byte[] {1}), true);
            fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET deadline = ? WHERE operation_id = 'seal'",
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
        publish("takeover", 0, "bytes");
        bucket.blockOpen = 1;
        try (var first = manualVerifier(data); var second = manualVerifier(replacement());
                var workers = Executors.newSingleThreadExecutor()) {
            var old = workers.submit(first::runOnce);
            assertThat(bucket.readStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(second.runOnce()).isFalse();
            fixture.jdbc.update("UPDATE qwen_tool_publication_operation SET claim_until = ?, verification_next_at = ?",
                    Timestamp.valueOf("2000-01-01 00:00:00"), Timestamp.valueOf("2000-01-01 00:00:00"));
            assertThat(second.runOnce()).isTrue();
            long epoch = fixture.jdbc.queryForObject("SELECT claim_epoch FROM qwen_tool_publication_operation", Long.class);
            bucket.objects.values().iterator().next()[0] = 'x';
            bucket.readRelease.countDown();
            assertThat(old.get(5, TimeUnit.SECONDS)).isTrue();
            assertThat(fixture.jdbc.queryForObject("SELECT claim_epoch FROM qwen_tool_publication_operation", Long.class))
                    .isEqualTo(epoch);
        }
        assertThat(status("takeover").path("state").asText()).isEqualTo("SUCCEEDED");
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object", String.class))
                .isEqualTo("VERIFIED");
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
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_operation", Integer.class))
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
        assertThat(fixture.jdbc.queryForObject("SELECT execution_mode FROM qwen_tool_publication_operation",
                String.class)).isEqualTo("SYNC");
        assertThat(status("sync").path("state").asText()).isEqualTo("RETRYABLE");
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "sync", "stdout", 0,
                new byte[] {1}, null, true).has("state")).isFalse();
        bucket.failPut = true;
        assertThatThrownBy(() -> publish("async", 1, "bytes")).hasMessageContaining("Unknown PUT result");
        assertThat(status("async").path("state").asText()).isEqualTo("RETRYABLE");
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isFalse();
            assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "async", "stdout", 1,
                    "bytes".getBytes(StandardCharsets.UTF_8), null, false).path("state").asText())
                    .isEqualTo("PENDING");
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(fixture.jdbc.queryForObject("SELECT execution_mode FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'async'", String.class)).isEqualTo("ASYNC");
        assertThat(status("async").path("state").asText()).isEqualTo("SUCCEEDED");
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
    void fencedAcceptedWorkFailsWithoutReadingAndStatusDoesNotReviveOrRenewIt() {
        publish("fenced", 0, "bytes");
        Timestamp deadline = fixture.jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation",
                Timestamp.class);
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = ?",
                Timestamp.valueOf("2000-01-01 00:00:00"));
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
        }
        assertThat(status("fenced").path("state").asText()).isEqualTo("FAILED");
        assertThat(bucket.opens).hasValue(0);
        for (int i = 0; i < 10; i++) status("fenced");
        assertThat(fixture.jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation", Timestamp.class))
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
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_seal", Integer.class))
                .isZero();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void finishVerifiesTheCompleteCaptureAndRejectsChangedManifestIdentity(boolean invalid) {
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
            assertThat(verifier.runOnce()).isTrue();
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
        try (var verifier = manualVerifier(data)) {
            assertThat(verifier.runOnce()).isTrue();
            assertThat(status("predecessor").path("state").asText()).isEqualTo("FAILED");
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
        private boolean blockPut;
        private int blockOpen;
        private boolean failRead;
        private boolean failPut;
        private RuntimeException readFailure;

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
            if (opens.incrementAndGet() == blockOpen) {
                readStarted.countDown();
                await(readRelease);
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
            return new ByteArrayInputStream(objects.get(objectKey));
        }

        @Override
        public void requireUnversioned() {}

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
