package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER_TOKEN = "a".repeat(32);
    private static final String PUBLICATION_TOKEN = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    private static final long CAPTURE_BYTES = 1024;
    private static final long ALLOCATION = CAPTURE_BYTES + ToolPublicationContract.PRODUCER_BYTES
            + ToolPublicationContract.ADMISSION_BYTES;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedSessionStore sessions;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcToolExecutionRepository executions;
    private ToolPublicationStore store;
    private ObjectNode binding;
    private JsonNode checkpoint;
    private JsonNode args;
    private long revision;
    private long sequence;
    private String commitDigest;

    @BeforeEach
    void setup() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:publication-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        sessions = new ManagedSessionStore(jdbc);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]),
                () -> "binding-1");
        executions = new JdbcToolExecutionRepository(source);
        store = newStore(10 * ALLOCATION, 10);
        var runtime = bindings.findOrCreate(new RuntimeProvisionRequest(
                new RuntimeScope("tenant-1", "workspace-1", "generation-1", "/workspace", "capability", "workspace"), null));
        runtime = bindings.claimOperation(runtime.getBindingId(), "owner", java.time.Duration.ofMinutes(1));
        assertThat(bindings.compareAndSet(runtime, runtime.withState(RuntimeBindingRecord.State.READY, null, Instant.now())))
                .isNotNull();
        binding = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", "pub-1").put("turnId", "turn-1").put("executionCallId", "execution-1")
                .put("modelCallId", "model-1").put("runtimeBindingId", "binding-1").put("bindingGeneration", "1")
                .put("captureId", "capture-1").put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("writerId", "writer-1").put("writerGeneration", 1)
                .put("activationId", "activation-1").put("activationEpoch", 1).put("intentSequence", 2);
        binding.set("sessionKey", JSON.createObjectNode().put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1").put("sessionId", "session-1"));
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
        binding.put("requestDigest", "sha256:" + digest(payload));
        binding.set("reference", JSON.createObjectNode().put("sessionId", "runtime-1").put("promptId", "runtime-prompt-1")
                .put("callId", "runtime-call-1").put("argsDigest", "sha256:" + digest("{\"command\":\"printf hi\"}")));
        args = JSON.createObjectNode().put("harnessSessionId", "session-1").put("runtimeSessionId", "runtime-1")
                .put("payloadJson", payload);
        binding.set("argsRef", ref("args-1", "managed-tool-input", args));
        ObjectNode cp = JSON.createObjectNode();
        cp.set("identity", JSON.createObjectNode().put("schemaVersion", 1).put("engine", "managed")
                .put("turnId", "turn-1").put("promptId", "runtime-prompt-1").put("activationId", "activation-1").put("coveredSequence", 2)
                .set("sessionKey", binding.get("sessionKey")));
        cp.set("continuation", JSON.createObjectNode().put("phase", "await_runtime"));
        cp.set("tools", JSON.createObjectNode().set("items", JSON.createArrayNode().add(JSON.createObjectNode()
                .put("executionCallId", "execution-1").put("functionCallId", "model-1").put("toolName", "run_shell_command")
                .put("state", "in_progress").put("outcomeSource", "runtime").put("inputDigest", digest(payload)))));
        checkpoint = cp;
        binding.set("checkpointRef", ref("checkpoint-1", "managed-checkpoint", checkpoint));
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-1", "idempotency-1", "binding-1", 1,
                "session-1", "runtime-1", "runtime-prompt-1", "runtime-call-1", "sha256:" + digest(payload),
                Map.of("sessionId", "runtime-1", "promptId", "runtime-prompt-1", "callId", "runtime-call-1",
                        "argsDigest", "sha256:" + digest(payload))));
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                WRITER_TOKEN, new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-1", 300000L)));
        append("session.create", "{}\n{}\n", 0, List.of(), null);
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-1").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        append("tool.dispatch", event(1, "activation.changed", activation("active"))
                + event(2, "tool.intent", intent) + "{}\n", 2,
                List.of(resource(binding.get("argsRef"), args), resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
    }

    @Test
    void replaysAcrossRepositoryReplacementAndKeyOrderWithoutLeakingSecret() {
        JsonNode first = reserve();
        ObjectNode reordered = request("reserve");
        ObjectNode key = JSON.createObjectNode().put("sessionId", "session-1").put("workspaceId", "workspace-1")
                .put("tenantId", "tenant-1");
        reordered.set("sessionKey", key);
        ((ObjectNode) reordered.get("binding")).set("sessionKey", key);
        assertThat(newStore(10 * ALLOCATION, 10).apply(reordered, WRITER_TOKEN, PUBLICATION_TOKEN)).isEqualTo(first);
        assertThat(first.toString()).doesNotContain(PUBLICATION_TOKEN).doesNotContain("writerToken");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM qwen_tool_publication", String.class))
                .isEqualTo(ToolPublicationContract.tokenHash(PUBLICATION_TOKEN));
    }

    @Test
    void rejectsConflictingTokenCapacityAndRebinding() {
        reserve();
        assertThatThrownBy(() -> store.apply(request("reserve"), WRITER_TOKEN,
                Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]).replaceFirst("A", "B")))
                .isInstanceOf(IllegalArgumentException.class);
        ObjectNode capacityChange = request("reserve").put("captureBytes", CAPTURE_BYTES + 1);
        assertThatThrownBy(() -> store.apply(capacityChange, WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("replay");
        ObjectNode changed = request("reserve");
        ((ObjectNode) changed.get("binding")).put("publicationId", "pub-2");
        ObjectNode duplicate = changed;
        assertThatThrownBy(() -> store.apply(duplicate, WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
    }

    @Test
    void refusesMissingChangedAndCorruptAuthoritativeEvidence() {
        binding.put("modelCallId", "other-model");
        assertThatThrownBy(this::reserve).hasMessageContaining("Checkpoint execution");
        binding.put("modelCallId", "model-1");
        binding.put("bindingGeneration", "2");
        assertThatThrownBy(this::reserve).hasMessageContaining("Broker execution");
        binding.put("bindingGeneration", "1");
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ? WHERE resource_id = 'args-1'",
                "{}".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(this::reserve).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isZero();
    }

    @Test
    void blockedRecoveryMayFenceButCannotReserveOrRenew() {
        reserve();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = 'BLOCKED_EXECUTION'");
        assertThatThrownBy(this::reserve).hasMessageContaining("recovery is blocked");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("recovery is blocked");
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null).path("state").asText()).isEqualTo("FENCED");
    }

    @Test
    void sameEpochReleasePreventsReserveAndRenew() {
        reserve();
        append("activation.release", event(3, "activation.changed", activation("released")) + "{}\n", 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        assertThatThrownBy(this::reserve).hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void fencesWithoutFreeingCapacityAndRequiresDurableNoStart() {
        reserve();
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null).path("state").asText()).isEqualTo("FENCED");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("fenced");
        assertThatThrownBy(() -> store.apply(request("close_not_started"), WRITER_TOKEN, null))
                .hasMessageContaining("not-started proof");
        var original = executions.findByExecutionCallId("execution-1");
        executions.requestCancel(original.getExecutionCallId(), original.getVersion());
        JsonNode closed = store.apply(request("close_not_started"), WRITER_TOKEN, null);
        assertThat(closed.path("state").asText()).isEqualTo("NOT_STARTED");
        assertThat(store.apply(request("close_not_started"), WRITER_TOKEN, null)).isEqualTo(closed);
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null)).isEqualTo(closed);
        assertThatThrownBy(this::reserve).hasMessageContaining("fenced");
    }

    @Test
    void replacementWriterMayFenceButCannotRenewOriginalPublication() {
        reserve();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                "b".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-2", 300000L)));
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN)).isInstanceOf(RuntimeException.class);
        ObjectNode replacement = request("renew");
        replacement.set("owner", JSON.createObjectNode().put("writerId", "writer-2").put("writerGeneration", 2));
        assertThatThrownBy(() -> store.apply(replacement, "b".repeat(32), PUBLICATION_TOKEN)).hasMessageContaining("Original writer");
        replacement.put("operation", "fence");
        assertThat(store.apply(replacement, "b".repeat(32), null).path("state").asText()).isEqualTo("FENCED");
    }

    @Test
    void concurrentReplayChargesOnceAndCapacityIncludesMetadata() throws Exception {
        store = newStore(ALLOCATION, 1);
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> { start.await(); return reserve(); });
            var two = pool.submit(() -> { start.await(); return reserve(); });
            start.countDown();
            assertThat(one.get()).isEqualTo(two.get());
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
        jdbc.update("DELETE FROM qwen_tool_publication");
        store = newStore(ALLOCATION - 1, 1);
        assertThatThrownBy(this::reserve).hasMessageContaining("capacity exhausted");
        store = newStore(ALLOCATION, 1);
        assertThat(reserve().path("captureBytes").asLong()).isEqualTo(CAPTURE_BYTES);
    }

    @Test
    void refusesFirstReservationAfterDispatchHasBeenClaimed() {
        var execution = executions.claimDispatch("execution-1", "dispatcher", java.time.Duration.ofMinutes(1));
        assertThat(execution).isNotNull();
        assertThatThrownBy(this::reserve).hasMessageContaining("before dispatch");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isZero();
    }

    @Test
    void originalReservationRemainsUsableWhileExecutionIsRunning() {
        JsonNode original = reserve();
        var execution = executions.claimDispatch("execution-1", "dispatcher", java.time.Duration.ofMinutes(1));
        assertThat(executions.compareAndSet(execution, execution.withState(ToolExecutionRecord.State.EXECUTING, false),
                "dispatcher", execution.getDispatchGeneration())).isNotNull();
        assertThat(reserve()).isEqualTo(original);
        assertThat(store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN).path("bindingDigest"))
                .isEqualTo(original.path("bindingDigest"));
    }

    @Test
    void renewsOriginalBindingWhenAnotherToolAdvancesTheWaitCheckpoint() {
        JsonNode original = reserve();
        ObjectNode originalBinding = binding.deepCopy();
        addSecondExecution();
        JsonNode renewed = store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN);
        assertThat(renewed.path("bindingDigest")).isEqualTo(original.path("bindingDigest"));
        ObjectNode replay = request("reserve");
        replay.set("binding", originalBinding);
        assertThat(store.apply(replay, WRITER_TOKEN, PUBLICATION_TOKEN).path("bindingDigest"))
                .isEqualTo(original.path("bindingDigest"));
        ObjectNode next = checkpoint.deepCopy();
        ((ObjectNode) next.path("tools").path("items").get(0)).put("state", "settled");
        JsonNode nextRef = ref("checkpoint-3", "managed-checkpoint", next);
        append("tool.wait", event(4, "checkpoint.saved", JSON.createObjectNode()) + "{}\n", 1,
                List.of(resource(nextRef, next)), "checkpoint-3");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Checkpoint execution");
    }

    @Test
    void cannotAdoptAnUnreservedIntentFromAnEarlierWriter() {
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                "b".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-2", 300000L)));
        ObjectNode candidate = request("reserve");
        ((ObjectNode) candidate.get("binding")).put("writerId", "writer-2").put("writerGeneration", 2);
        candidate.set("owner", JSON.createObjectNode().put("writerId", "writer-2").put("writerGeneration", 2));
        assertThatThrownBy(() -> store.apply(candidate, "b".repeat(32), PUBLICATION_TOKEN))
                .hasMessageContaining("Original intent writer");
    }

    @Test
    void concurrentDistinctReservationsCannotOversubscribeAndOnlyNoStartFreesCapacity() throws Exception {
        ObjectNode second = addSecondExecution();
        store = newStore(ALLOCATION, 10);
        ObjectNode firstRequest = request("reserve");
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        CountDownLatch start = new CountDownLatch(1);
        List<Object> outcomes;
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> attempt(start, firstRequest));
            var two = pool.submit(() -> attempt(start, secondRequest));
            start.countDown();
            outcomes = List.of(one.get(), two.get());
        }
        assertThat(outcomes.stream().filter(JsonNode.class::isInstance).count()).isEqualTo(1);
        assertThat(outcomes.stream().filter(IllegalArgumentException.class::isInstance).count()).isEqualTo(1);
        String winner = jdbc.queryForObject("SELECT publication_id FROM qwen_tool_publication", String.class);
        ObjectNode loser = "pub-1".equals(winner) ? secondRequest : firstRequest;
        ObjectNode fence = request("fence").put("publicationId", winner);
        store.apply(fence, WRITER_TOKEN, null);
        assertThatThrownBy(() -> store.apply(loser, WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("capacity exhausted");
        String executionId = "pub-1".equals(winner) ? "execution-1" : "execution-2";
        var execution = executions.findByExecutionCallId(executionId);
        executions.requestCancel(executionId, execution.getVersion());
        fence.put("operation", "close_not_started");
        store.apply(fence, WRITER_TOKEN, null);
        store.apply(fence, WRITER_TOKEN, null);
        assertThat(store.apply(loser, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText()).isEqualTo("OPEN");
    }

    private Object attempt(CountDownLatch start, JsonNode request) throws InterruptedException {
        start.await();
        try {
            return store.apply(request, WRITER_TOKEN, PUBLICATION_TOKEN);
        } catch (IllegalArgumentException error) {
            return error;
        }
    }

    private ObjectNode addSecondExecution() {
        ObjectNode second = binding.deepCopy().put("publicationId", "pub-2").put("executionCallId", "execution-2")
                .put("captureId", "capture-2").put("modelCallId", "model-2").put("intentSequence", 3);
        ((ObjectNode) second.get("reference")).put("callId", "runtime-call-2");
        ObjectNode nextCheckpoint = checkpoint.deepCopy();
        ((ObjectNode) nextCheckpoint.get("identity")).put("coveredSequence", 3);
        ObjectNode item = nextCheckpoint.path("tools").path("items").get(0).deepCopy();
        item.put("executionCallId", "execution-2").put("functionCallId", "model-2");
        ((com.fasterxml.jackson.databind.node.ArrayNode) nextCheckpoint.path("tools").path("items")).add(item);
        checkpoint = nextCheckpoint;
        binding.set("checkpointRef", ref("checkpoint-2", "managed-checkpoint", checkpoint));
        second.set("checkpointRef", binding.get("checkpointRef"));
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-2").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        append("tool.dispatch", event(3, "tool.intent", intent) + "{}\n", 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-2");
        String digest = binding.path("requestDigest").asText();
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-2", "idempotency-2", "binding-1", 1,
                "session-1", "runtime-1", "runtime-prompt-1", "runtime-call-2", digest,
                Map.of("sessionId", "runtime-1", "promptId", "runtime-prompt-1", "callId", "runtime-call-2", "argsDigest", digest)));
        return second;
    }

    private ToolPublicationStore newStore(long bytes, long count) {
        return new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, bytes, bytes, count));
    }

    private JsonNode reserve() {
        return store.apply(request("reserve"), WRITER_TOKEN, PUBLICATION_TOKEN);
    }

    private ObjectNode request(String operation) {
        ObjectNode result = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("operation", operation);
        result.set("sessionKey", binding.get("sessionKey").deepCopy());
        result.set("owner", JSON.createObjectNode().put("writerId", "writer-1").put("writerGeneration", 1));
        if ("reserve".equals(operation)) {
            result.set("binding", binding.deepCopy());
            result.put("captureBytes", CAPTURE_BYTES);
        } else {
            result.put("publicationId", "pub-1");
        }
        return result;
    }

    private ObjectNode activation(String phase) {
        return JSON.createObjectNode().put("activationId", "activation-1").put("epoch", 1)
                .put("phase", phase).put("expiresAt", System.currentTimeMillis() + 180000);
    }

    private String event(long number, String kind, JsonNode payload) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", number).put("kind", kind);
        event.set("sessionKey", binding.get("sessionKey"));
        event.set("payload", payload);
        event.set("subject", JSON.createObjectNode().put("type", "activation").put("activationId", "activation-1").put("epoch", 1));
        return JSON.createObjectNode().put("subtype", "managed_session_event_v1").set("managedSession", event) + "\n";
    }

    private void append(String operation, String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources, String checkpointId) {
        String nextDigest = events == 0 ? null : digest(records);
        var request = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                revision, sequence, "transaction-" + revision, operation, "command-" + revision, digest(records),
                events == 0 ? 0 : sequence + 1, sequence + events, events, nextDigest, commitDigest, nextDigest,
                events == 0 ? 0 : 1, checkpointId, events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), digest(records), resources);
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.commit("tenant-1", "session-1", WRITER_TOKEN, request));
        revision++;
        sequence += events;
        commitDigest = nextDigest;
    }

    private static ObjectNode ref(String id, String kind, JsonNode body) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", body.toString().getBytes(StandardCharsets.UTF_8).length).put("digest", digest(body.toString()));
    }

    private static ManagedSessionStoreModels.CommitResource resource(JsonNode ref, JsonNode body) {
        return new ManagedSessionStoreModels.CommitResource(ref.path("resourceId").asText(), ref.path("kind").asText(),
                1, ref.path("byteLength").asLong(), ref.path("digest").asText(),
                Base64.getEncoder().encodeToString(body.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static String digest(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }
}
