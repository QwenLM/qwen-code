package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Shared writer-owned session-journal fixture for the tool-publication
 * tests: the binding and checkpoint the publication contract expects, an
 * active activation, and one tool.intent, all committed through the
 * production stores. The caller migrates the given DataSource first.
 */
public final class PublicationJournalFixture {
    private static final ObjectMapper JSON = new ObjectMapper();
    public static final String WRITER_TOKEN = "a".repeat(32);
    public static final String PUBLICATION_TOKEN = Base64.getUrlEncoder()
            .withoutPadding().encodeToString(new byte[32]);
    public static final long CAPTURE_BYTES = 1024;
    public static final long ALLOCATION = CAPTURE_BYTES
            + ToolPublicationContract.PRODUCER_BYTES
            + ToolPublicationContract.ADMISSION_BYTES;
    public static final String ACTIVATION_ID = "activation-1";
    /** The commit-marker record line, byte-stable: the marker byte cap and
     * the shared contract fixture pin its shape. */
    public static final String COMMIT_MARKER =
            "{\"subtype\":\"managed_session_commit_v1\"}\n";

    public final JdbcTemplate jdbc;
    public final DataSourceTransactionManager manager;
    public final ManagedSessionStore sessions;
    public final JdbcRuntimeBindingRepository bindings;
    public final JdbcToolExecutionRepository executions;
    public final ToolPublicationStore store;
    public ObjectNode binding;
    public ObjectNode checkpoint;
    public ObjectNode args;
    public long revision;
    public long sequence;
    public String commitDigest;
    public WorkspaceCsiReservationStore.Reservation csiReservation;

    private PublicationJournalFixture(DataSource source,
            boolean journalHeadAuthorization) {
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        sessions = new ManagedSessionStore(jdbc);
        bindings = new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("key", new byte[32]),
                () -> "binding-1");
        executions = new JdbcToolExecutionRepository(source);
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
    }

    public static PublicationJournalFixture create(DataSource source,
            boolean journalHeadAuthorization) {
        return create(source, journalHeadAuthorization, null);
    }

    public static PublicationJournalFixture create(DataSource source,
            boolean journalHeadAuthorization, WorkspaceCsiRegistration registration) {
        PublicationJournalFixture fixture =
                new PublicationJournalFixture(source, journalHeadAuthorization);
        fixture.populate(source, registration);
        return fixture;
    }

    private void populate(DataSource source, WorkspaceCsiRegistration registration) {
        boolean csi = registration != null;
        var scope = new RuntimeScope("tenant-1", "workspace-1", csi ? "1" : "generation-1",
                "/workspace", csi ? "sha256:" + "a".repeat(64) : "capability", csi ? "session" : "workspace");
        var runtime = bindings.findOrCreate(csi
                ? new RuntimeProvisionRequest(scope, "session-1", "kubernetes-workspace", registration.storageId())
                : new RuntimeProvisionRequest(scope, null));
        runtime = bindings.claimOperation(runtime.getBindingId(), "owner", Duration.ofMinutes(1));
        if (csi) {
            var csiStore = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
            csiStore.register(registration);
            csiReservation = csiStore.reserve(registration, bindings, runtime, UUID.randomUUID().toString());
            var seed = runtime.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            runtime = bindings.compareAndSet(runtime, runtime.withAttestation(lease,
                    new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("fixture", "local-db")),
                    Instant.now(), Instant.now()));
            var nativeSessions = new JdbcRuntimeSessionRepository(source);
            var acquiring = bindings.admitSession(nativeSessions, new RuntimeSessionRecord(
                    new RuntimeSession("session-1", "runtime-1", "bootstrap", scope), "binding-1", 1,
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            nativeSessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        } else {
            runtime = bindings.compareAndSet(runtime, runtime.withState(RuntimeBindingRecord.State.READY, null, Instant.now()));
        }
        assertThat(runtime).isNotNull();
        binding = JSON.createObjectNode()
                .put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", "pub-1").put("turnId", "turn-1")
                .put("executionCallId", "execution-1")
                .put("modelCallId", "model-1")
                .put("runtimeBindingId", "binding-1")
                .put("bindingGeneration", "1").put("captureId", "capture-1")
                .put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required")
                .put("writerId", "writer-1").put("writerGeneration", 1)
                .put("activationId", ACTIVATION_ID).put("activationEpoch", 1)
                .put("intentSequence", 2);
        binding.set("sessionKey", JSON.createObjectNode()
                .put("tenantId", "tenant-1").put("workspaceId", "workspace-1")
                .put("sessionId", "session-1"));
        String payload =
                "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
        binding.put("requestDigest", "sha256:" + digest(payload));
        binding.set("reference", JSON.createObjectNode()
                .put("sessionId", "runtime-1")
                .put("promptId", "runtime-prompt-1")
                .put("callId", "runtime-call-1")
                .put("argsDigest",
                        "sha256:" + digest("{\"command\":\"printf hi\"}")));
        args = JSON.createObjectNode()
                .put("harnessSessionId", "session-1")
                .put("runtimeSessionId", "runtime-1")
                .put("payloadJson", payload);
        binding.set("argsRef", ref("args-1", "managed-tool-input", args));
        checkpoint = JSON.createObjectNode();
        checkpoint.set("identity", JSON.createObjectNode()
                .put("schemaVersion", 1).put("engine", "managed")
                .put("turnId", "turn-1").put("promptId", "runtime-prompt-1")
                .put("activationId", ACTIVATION_ID)
                .put("coveredSequence", 2)
                .set("sessionKey", binding.get("sessionKey")));
        checkpoint.set("continuation",
                JSON.createObjectNode().put("phase", "await_runtime"));
        checkpoint.set("tools", JSON.createObjectNode().set("items",
                JSON.createArrayNode().add(JSON.createObjectNode()
                        .put("executionCallId", "execution-1")
                        .put("functionCallId", "model-1")
                        .put("toolName", "run_shell_command")
                        .put("state", "in_progress")
                        .put("outcomeSource", "runtime")
                        .put("inputDigest",
                                digest("{\"command\":\"printf hi\"}")))));
        binding.set("checkpointRef",
                ref("checkpoint-1", "managed-checkpoint", checkpoint));
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-1",
                "idempotency-1", "binding-1", 1, "session-1", "runtime-1",
                "runtime-prompt-1", "runtime-call-1",
                "sha256:" + digest(payload),
                Map.of("sessionId", "runtime-1", "promptId",
                        "runtime-prompt-1", "callId", "runtime-call-1",
                        "argsDigest",
                        "sha256:" + digest("{\"command\":\"printf hi\"}"),
                        "payloadDigest", "sha256:" + digest(payload),
                        "dispatchMode", "deferred_v3", "publicationId",
                        "pub-1")));
        new TransactionTemplate(manager).executeWithoutResult(status ->
                sessions.acquireWriter("tenant-1", "session-1", WRITER_TOKEN,
                        new ManagedSessionStoreModels.AcquireWriterRequest(
                                "workspace-1", "writer-1", 300000L)));
        append("session.create", "{}\n{}\n", 0, List.of(), null);
        append("tool.dispatch",
                event(1, "activation.changed", activation("active"))
                        + event(2, "tool.intent",
                                intentPayload(binding.get("argsRef")))
                        + COMMIT_MARKER, 2,
                List.of(resource(binding.get("argsRef"), args),
                        resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
    }

    public ToolPublicationStore newStore(long bytes, long count) {
        return newStore(bytes, count, false);
    }

    public ToolPublicationStore newStore(long bytes, long count,
            boolean journalHeadAuthorization) {
        return new ToolPublicationStore(jdbc, manager, sessions, executions,
                bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, bytes,
                        bytes, count),
                journalHeadAuthorization);
    }

    public JsonNode reserve() {
        return store.apply(request("reserve"), WRITER_TOKEN, PUBLICATION_TOKEN);
    }

    public ObjectNode request(String operation) {
        ObjectNode result = JSON.createObjectNode()
                .put("publication", ToolPublicationContract.PROTOCOL)
                .put("operation", operation);
        result.set("sessionKey", binding.get("sessionKey").deepCopy());
        result.set("owner", JSON.createObjectNode().put("writerId", "writer-1")
                .put("writerGeneration", 1));
        if ("reserve".equals(operation)) {
            result.set("binding", binding.deepCopy());
            result.put("captureBytes", CAPTURE_BYTES);
        } else {
            result.put("publicationId", "pub-1");
        }
        return result;
    }

    /** An activation.changed payload the authority's reader accepts: an
     * open phase holds its lease and install and no boundary, a closed one
     * holds its boundary. */
    public static ObjectNode activation(String phase) {
        ObjectNode activation = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID)
                .put("epoch", 1).put("workerId", "worker-1");
        activation.set("subject", activationSubject());
        activation.put("phase", phase)
                .put("expiresAt", System.currentTimeMillis() + 180000);
        if ("active".equals(phase) || "installing".equals(phase)) {
            activation.put("leaseDurationMs", 300000);
            activation.set("installRef", ref("install-1", "managed-install",
                    JSON.createObjectNode()));
            activation.putNull("boundaryRef");
        } else {
            activation.putNull("leaseDurationMs");
            activation.putNull("installRef");
            activation.set("boundaryRef", ref("boundary-1",
                    "managed-boundary", JSON.createObjectNode()));
        }
        return activation;
    }

    /** A tool.intent payload the authority's reader accepts. */
    public static ObjectNode intentPayload(JsonNode argsRef) {
        ObjectNode intent = JSON.createObjectNode()
                .put("executionCallId", "execution-1")
                .put("batchId", "batch-1").put("ordinal", 1)
                .put("outcomeSource", "runtime");
        intent.set("argsRef", argsRef);
        intent.set("toolDefinitionRef", ref("tooldef-1",
                "managed-tool-definition", JSON.createObjectNode()
                        .put("toolName", "run_shell_command")));
        return intent;
    }

    /** A checkpoint.committed payload the authority's reader accepts. */
    public static ObjectNode checkpointPayload(String checkpointId) {
        ObjectNode payload = JSON.createObjectNode()
                .put("checkpointId", checkpointId)
                .put("coveredSequence", 2);
        payload.putNull("previousCheckpointId");
        payload.set("stateRef", ref("checkpoint-state-1",
                "managed-checkpoint-state", JSON.createObjectNode()));
        payload.putNull("boundary");
        return payload;
    }

    /** The activation subject the event lines carry, scope and all. */
    private static ObjectNode activationSubject() {
        return JSON.createObjectNode().put("type", "activation")
                .put("scopeId", "activation-1")
                .put("activationId", ACTIVATION_ID).put("epoch", 1);
    }

    public String event(long number, String kind, JsonNode payload) {
        return event(number, kind, payload, binding.get("sessionKey"), 1);
    }

    /** The same event line with a caller-chosen scope and version, in the
     * envelope the authority's composer writes. */
    public static String event(long number, String kind, JsonNode payload,
            JsonNode sessionKey, int v) {
        return ExtensionRecordJournal.line(sessionKey.path("sessionId")
                .asText(), "managed_session_event_v1",
                eventNode(number, kind, payload, sessionKey, v));
    }

    /** The event one line of {@link #event} carries. */
    public static ObjectNode eventNode(long number, String kind,
            JsonNode payload, JsonNode sessionKey, int v) {
        ObjectNode event = JSON.createObjectNode().put("v", v)
                .put("sequence", number).put("kind", kind);
        event.set("sessionKey", sessionKey);
        event.set("payload", payload);
        event.put("eventId", "event-" + number);
        event.put("occurredAt", 1_000L * number);
        event.set("subject", activationSubject());
        return event;
    }

    public void append(String operation, String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources,
            String checkpointId) {
        String nextDigest = events == 0 ? null : digest(records);
        var request = new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace-1", "writer-1", 1, revision, sequence,
                "transaction-" + revision, operation, "command-" + revision,
                digest(records), events == 0 ? 0 : sequence + 1,
                sequence + events, events, nextDigest, commitDigest,
                nextDigest, events == 0 ? 0 : 1, checkpointId,
                events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(
                        records.getBytes(StandardCharsets.UTF_8)),
                digest(records), resources);
        new TransactionTemplate(manager).executeWithoutResult(status ->
                sessions.commit("tenant-1", "session-1", WRITER_TOKEN,
                        request));
        revision++;
        sequence += events;
        commitDigest = nextDigest;
    }

    public static ObjectNode ref(String id, String kind, JsonNode body) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind)
                .put("schemaVersion", 1)
                .put("byteLength",
                        body.toString().getBytes(StandardCharsets.UTF_8).length)
                .put("digest", digest(body.toString()));
    }

    public static ManagedSessionStoreModels.CommitResource resource(
            JsonNode ref, JsonNode body) {
        return new ManagedSessionStoreModels.CommitResource(
                ref.path("resourceId").asText(), ref.path("kind").asText(), 1,
                ref.path("byteLength").asLong(), ref.path("digest").asText(),
                Base64.getEncoder().encodeToString(
                        body.toString().getBytes(StandardCharsets.UTF_8)));
    }

    public static String digest(String value) {
        return ToolPublicationContract.sha256(
                value.getBytes(StandardCharsets.UTF_8));
    }
}
