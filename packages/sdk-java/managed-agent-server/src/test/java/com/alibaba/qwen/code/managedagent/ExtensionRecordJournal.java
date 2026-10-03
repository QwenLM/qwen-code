package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;

/**
 * Commits journal transactions to the Session store in the record format the
 * Session authority writes, each carrying one Stage H record revision.
 */
final class ExtensionRecordJournal {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER = "writer-extension";
    private static final String TOKEN = "extension-writer-token-0123456789";
    static final String OPERATION = "commitMonitorRun";
    private final ManagedSessionStore store;
    private final String tenantId;
    private final String workspaceId;
    private final String sessionId;
    private long writerGeneration;
    private long journalRevision;
    private long sequence;
    private String lastCommitDigest;
    private int domainEvents;

    ExtensionRecordJournal(ManagedSessionStore store, String tenantId,
            String workspaceId, String sessionId) {
        this.store = store;
        this.tenantId = tenantId;
        this.workspaceId = workspaceId;
        this.sessionId = sessionId;
    }

    /** Acquires the writer and commits the Session's genesis. */
    ExtensionRecordJournal open() {
        acquire().commit(genesis(
                "{\"subtype\":\"session_execution_engine\"}\n"
                        + "{\"subtype\":\"managed_session_header_v1\"}\n",
                List.of()));
        journalRevision = 1;
        return this;
    }

    /** Acquires the writer and leaves the genesis to the test. */
    ExtensionRecordJournal acquire() {
        writerGeneration = store.acquireWriter(tenantId, sessionId, TOKEN,
                new AcquireWriterRequest(workspaceId, WRITER, 60_000L))
                .writerGeneration();
        return this;
    }

    /** The genesis transaction with two record lines. */
    CommitTransactionRequest genesis(String records,
            List<CommitResource> resources) {
        return new CommitTransactionRequest(workspaceId, WRITER,
                writerGeneration, 0, 0, "transaction-genesis",
                "session.create", "command-genesis", sha256("genesis"), 0, 0,
                0, null, null, null, 0, null, 2, base64(records),
                sha256(records), resources);
    }

    CommitReceipt commitMonitor(String commandId, JsonNode monitor,
            long occurredAt) {
        CommitTransactionRequest request = request(commandId, monitor,
                occurredAt);
        CommitReceipt receipt = commit(request);
        committed(request);
        return receipt;
    }

    CommitReceipt commit(CommitTransactionRequest request) {
        return store.commit(tenantId, sessionId, TOKEN, request);
    }

    /**
     * The commit request for one revision; committing the same request again
     * replays it.
     */
    CommitTransactionRequest request(String commandId, JsonNode monitor,
            long occurredAt) {
        return request(OPERATION, commandId, bytes(monitor), occurredAt,
                event -> {
                }, records -> records);
    }

    /**
     * A commit request of an operation whose body bytes, event or record
     * lines a test may change, as a writer that does not follow the contract
     * would.
     */
    CommitTransactionRequest request(String operation, String commandId,
            byte[] body, long occurredAt, Consumer<ObjectNode> editEvent,
            UnaryOperator<String> editRecords) {
        return request(operation, commandId, body, occurredAt, editEvent,
                editRecords, 0);
    }

    /**
     * A commit request that declares {@code extraEvents} more events after
     * the Stage H one, whose lines {@code editRecords} supplies.
     */
    CommitTransactionRequest request(String operation, String commandId,
            byte[] body, long occurredAt, Consumer<ObjectNode> editEvent,
            UnaryOperator<String> editRecords, int extraEvents) {
        return request(operation, commandId, body, occurredAt, editEvent,
                editRecords, extraEvents, "monitor_run", List.of());
    }

    CommitTransactionRequest requestDomain(String commandId, String domain,
            JsonNode body, List<CommitResource> resources, long occurredAt) {
        return request("commitMcpRecord", commandId, bytes(body), occurredAt,
                event -> { }, records -> records, 0, domain, resources);
    }

    private CommitTransactionRequest request(String operation, String commandId,
            byte[] body, long occurredAt, Consumer<ObjectNode> editEvent,
            UnaryOperator<String> editRecords, int extraEvents, String domain,
            List<CommitResource> resources) {
        String resourceId = resourceId(body);
        ObjectNode recordRef = JSON.createObjectNode()
                .put("resourceId", resourceId)
                .put("kind", "managed-" + domain)
                .put("schemaVersion", 1)
                .put("byteLength", body.length)
                .put("digest", sha256(body));
        long next = sequence + 1;
        ObjectNode event = JSON.createObjectNode().put("v", 1)
                .put("sequence", next)
                .put("eventId", domain + ":" + (domainEvents + 1));
        event.putObject("sessionKey").put("tenantId", tenantId)
                .put("workspaceId", workspaceId).put("sessionId", sessionId);
        event.put("kind", "domain.committed").put("occurredAt", occurredAt);
        event.putObject("payload").put("domain", domain)
                .put("version", 1).put("operationId", commandId)
                .set("recordRef", recordRef);
        editEvent.accept(event);
        String records = editRecords.apply(line("managed_session_event_v1",
                event) + line("managed_session_commit_v1",
                        JSON.createObjectNode().put("commandId", commandId)));
        String transactionId = "transaction-" + operation + "-" + commandId;
        List<CommitResource> closure = new ArrayList<>(resources);
        closure.add(new CommitResource(resourceId, "managed-" + domain, 1,
                body.length, sha256(body), Base64.getEncoder().encodeToString(body)));
        return new CommitTransactionRequest(workspaceId, WRITER,
                writerGeneration, journalRevision, sequence, transactionId,
                operation, commandId, sha256(commandId), next,
                next + extraEvents, 1 + extraEvents,
                sha256("events-" + commandId), lastCommitDigest,
                sha256(transactionId), 0, null, 2 + extraEvents,
                base64(records),
                sha256(records), closure);
    }

    /** Advances past a request the store committed. */
    void committed(CommitTransactionRequest request) {
        journalRevision++;
        sequence = request.lastSequence();
        lastCommitDigest = request.commitDigest();
        domainEvents++;
    }

    long committedSequence() {
        return sequence;
    }

    /** The resource that holds a body; equal bodies share one. */
    static String resourceId(byte[] body) {
        return UUID.nameUUIDFromBytes(body).toString();
    }

    static byte[] bytes(JsonNode node) {
        try {
            return JSON.writeValueAsBytes(node);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    private String line(String subtype, JsonNode body) {
        ObjectNode record = JSON.createObjectNode()
                .put("uuid", UUID.randomUUID().toString())
                .putNull("parentUuid")
                .put("sessionId", sessionId)
                .put("timestamp", "2026-09-27T00:00:00.000Z")
                .put("type", "system")
                .put("subtype", subtype)
                .put("cwd", "/workspace")
                .put("version", "test");
        record.set("managedSession", body);
        return new String(bytes(record), StandardCharsets.UTF_8) + "\n";
    }

    private static String base64(String value) {
        return Base64.getEncoder().encodeToString(
                value.getBytes(StandardCharsets.UTF_8));
    }

    static String sha256(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
