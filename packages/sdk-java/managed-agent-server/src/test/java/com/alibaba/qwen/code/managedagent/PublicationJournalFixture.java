package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionRecords;
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
import com.fasterxml.jackson.databind.node.TextNode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Shared writer-owned session-journal fixture for the tool-publication
 * tests: the binding and checkpoint the publication contract expects, an
 * active activation, and one tool.intent, all committed through the
 * production stores in the faithful journal shapes the Session store
 * verifies — closed events at their sequences, a commit marker ending
 * every transaction with canonical content digests to match. The caller
 * migrates the given DataSource first.
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
        PublicationJournalFixture fixture =
                new PublicationJournalFixture(source, journalHeadAuthorization);
        fixture.populate();
        return fixture;
    }

    private void populate() {
        var runtime = bindings.findOrCreate(new RuntimeProvisionRequest(
                new RuntimeScope("tenant-1", "workspace-1", "generation-1",
                        "/workspace", "capability", "workspace"), null));
        runtime = bindings.claimOperation(runtime.getBindingId(), "owner",
                Duration.ofMinutes(1));
        assertThat(bindings.compareAndSet(runtime, runtime.withState(
                RuntimeBindingRecord.State.READY, null, Instant.now())))
                .isNotNull();
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
        append("session.create", engineLine() + headerLine(), 0, List.of(),
                null);
        ObjectNode intent = toolIntent("execution-1");
        intent.set("argsRef", binding.get("argsRef"));
        append("tool.dispatch",
                event(1, "activation.changed", activation("active"))
                        + event(2, "tool.intent", intent), 2,
                List.of(resource(binding.get("argsRef"), args),
                        resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
    }

    /** The faithful shapes a tool.intent's closed payload needs. */
    public static ObjectNode toolIntent(String executionCallId) {
        ObjectNode intent = JSON.createObjectNode()
                .put("executionCallId", executionCallId)
                .put("batchId", "batch-1").put("ordinal", 1)
                .put("outcomeSource", "runtime");
        intent.set("toolDefinitionRef",
                ref("tool-definition-1", "managed-tool-definition",
                        TextNode.valueOf("tool-definition")));
        return intent;
    }

    /** The foreign engine record of the genesis transaction. */
    public static String engineLine() {
        return "{\"subtype\":\"session_execution_engine\",\"sessionId\":"
                + "\"session-1\"}\n";
    }

    /** The Managed header record, with the body the authority writes. */
    public static String headerLine() {
        ObjectNode header = JSON.createObjectNode()
                .put("formatVersion", 1)
                .put("minimumReader", "managed-session/1")
                .put("engine", "managed").put("createdBy", "test");
        header.putObject("sessionKey").put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1")
                .put("sessionId", "session-1");
        header.set("definitionRef",
                ref("session-definition", "managed-session-definition",
                        TextNode.valueOf("session-definition")));
        header.set("rootSnapshotRef",
                ref("session-root-snapshot", "managed-session-root-snapshot",
                        TextNode.valueOf("session-root-snapshot")));
        return JSON.createObjectNode()
                .put("subtype", "managed_session_header_v1")
                .put("sessionId", "session-1")
                .set("managedSession", header) + "\n";
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

    public ObjectNode activation(String phase) {
        ObjectNode payload = JSON.createObjectNode()
                .put("activationId", ACTIVATION_ID).put("epoch", 1)
                .put("workerId", "worker-1").put("phase", phase)
                .put("expiresAt", System.currentTimeMillis() + 180000);
        payload.set("subject", activationSubject());
        if ("installing".equals(phase) || "active".equals(phase)) {
            payload.put("leaseDurationMs", 300_000);
            payload.set("installRef",
                    ref("activation-install-1", "managed-activation-install",
                            TextNode.valueOf("activation-install")));
            payload.putNull("boundaryRef");
        } else {
            payload.putNull("leaseDurationMs");
            payload.putNull("installRef");
            payload.set("boundaryRef",
                    ref("activation-boundary-1", "managed-activation-boundary",
                            TextNode.valueOf("activation-boundary")));
        }
        return payload;
    }

    /** A faithful activation subject. */
    public static ObjectNode activationSubject() {
        return JSON.createObjectNode().put("type", "activation")
                .put("scopeId", "scope-1")
                .put("activationId", ACTIVATION_ID).put("epoch", 1);
    }

    public String event(long number, String kind, JsonNode payload) {
        return event(number, kind, payload, binding.get("sessionKey"), 1);
    }

    /** The same event line with a caller-chosen scope and version. */
    public String event(long number, String kind, JsonNode payload,
            JsonNode sessionKey, int v) {
        ObjectNode event = JSON.createObjectNode().put("v", v)
                .put("sequence", number).put("kind", kind)
                .put("eventId", "event-" + number).put("occurredAt", 1_000);
        event.set("sessionKey", sessionKey);
        event.set("payload", payload);
        event.set("subject", activationSubject());
        return JSON.createObjectNode()
                .put("subtype", "managed_session_event_v1")
                .put("sessionId", "session-1")
                .set("managedSession", event) + "\n";
    }

    /**
     * The commit marker the authority ends a transaction with, agreeing
     * with the declared fields the transaction commits under.
     */
    public static String markerLine(String transactionId, String operation,
            String commandId, String contentDigest, long first, long last,
            String eventsDigest, String previousCommitDigest) {
        ObjectNode marker = JSON.createObjectNode()
                .put("transactionId", transactionId)
                .put("commandId", commandId)
                .put("operation", operation)
                .put("contentDigest", contentDigest)
                .put("firstSequence", first)
                .put("lastSequence", last)
                .put("eventCount", last - first + 1)
                .put("eventsDigest", eventsDigest);
        if (previousCommitDigest == null) {
            marker.putNull("previousCommitDigest");
        } else {
            marker.put("previousCommitDigest", previousCommitDigest);
        }
        return JSON.createObjectNode()
                .put("subtype", "managed_session_commit_v1")
                .put("sessionId", "session-1")
                .set("managedSession", marker) + "\n";
    }

    /** The canonical digest of the events the text of `eventsLines` carries. */
    public static String canonicalEventDigest(String eventsLines) {
        com.fasterxml.jackson.databind.node.ArrayNode events =
                com.fasterxml.jackson.databind.node.JsonNodeFactory.instance
                        .arrayNode();
        for (String line : eventsLines.split("\n")) {
            JsonNode record = json(line);
            if (!"managed_session_event_v1".equals(record.path("subtype")
                    .textValue())) {
                continue;
            }
            events.add(record.path("managedSession"));
        }
        return ManagedSessionRecords.canonicalDigest(events);
    }

    /** The canonical digest of the commit marker of `records`. */
    public static String canonicalMarkerDigest(String records) {
        int at = records.lastIndexOf("{\"subtype\":\"managed_session_commit_v1\"");
        return ManagedSessionRecords.canonicalDigest(
                json(records.substring(at, records.length() - 1))
                        .path("managedSession"));
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    public void append(String operation, String eventsLines, int events,
            List<ManagedSessionStoreModels.CommitResource> resources,
            String checkpointId) {
        String nextDigest = events == 0 ? null
                : canonicalEventDigest(eventsLines);
        long first = events == 0 ? 0 : sequence + 1;
        long last = first + events - (events == 0 ? 0 : 1);
        String commandId = "command-" + revision;
        String records = events > 0 ? eventsLines
                + markerLine("transaction-" + revision, operation,
                        commandId, digest(commandId), first, last, nextDigest,
                        commitDigest)
                : eventsLines;
        String newCommitDigest = events == 0 ? null
                : canonicalMarkerDigest(records);
        var request = new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace-1", "writer-1", 1, revision, sequence,
                "transaction-" + revision, operation, commandId,
                digest(commandId), first, last, events, nextDigest,
                commitDigest, newCommitDigest, events == 0 ? 0 : 1,
                checkpointId, events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(
                        records.getBytes(StandardCharsets.UTF_8)),
                digest(records), resources);
        new TransactionTemplate(manager).executeWithoutResult(status ->
                sessions.commit("tenant-1", "session-1", WRITER_TOKEN,
                        request));
        revision++;
        sequence += events;
        commitDigest = newCommitDigest;
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
