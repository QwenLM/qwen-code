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
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/**
 * Commits journal transactions to the Session store in the record format the
 * Session authority writes, each carrying one Stage H record revision.
 */
final class ExtensionRecordJournal {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER = "writer-extension";
    private static final String TOKEN = "extension-writer-token-0123456789";
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
        writerGeneration = store.acquireWriter(tenantId, sessionId, TOKEN,
                new AcquireWriterRequest(workspaceId, WRITER, 60_000L))
                .writerGeneration();
        String records = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
        store.commit(tenantId, sessionId, TOKEN, new CommitTransactionRequest(
                workspaceId, WRITER, writerGeneration, 0, 0,
                "transaction-genesis", "session.create", "command-genesis",
                sha256("genesis"), 0, 0, 0, null, null, null, 0, null, 2,
                base64(records), sha256(records), List.of()));
        journalRevision = 1;
        return this;
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
        byte[] body = bytes(monitor);
        String resourceId = UUID.nameUUIDFromBytes(body).toString();
        ObjectNode recordRef = JSON.createObjectNode()
                .put("resourceId", resourceId)
                .put("kind", "managed-monitor_run")
                .put("schemaVersion", 1)
                .put("byteLength", body.length)
                .put("digest", sha256(body));
        long next = sequence + 1;
        ObjectNode event = JSON.createObjectNode().put("v", 1)
                .put("sequence", next)
                .put("eventId", "monitor_run:" + (domainEvents + 1));
        event.putObject("sessionKey").put("tenantId", tenantId)
                .put("workspaceId", workspaceId).put("sessionId", sessionId);
        event.put("kind", "domain.committed").put("occurredAt", occurredAt);
        event.putObject("payload").put("domain", "monitor_run")
                .put("version", 1).put("operationId", commandId)
                .set("recordRef", recordRef);
        String records = line("managed_session_event_v1", event)
                + line("managed_session_commit_v1",
                        JSON.createObjectNode().put("commandId", commandId));
        String transactionId = "transaction-" + commandId;
        return new CommitTransactionRequest(workspaceId, WRITER,
                writerGeneration, journalRevision, sequence, transactionId,
                "commitMonitorRun", commandId, sha256(commandId), next, next,
                1, sha256("events-" + commandId), lastCommitDigest,
                sha256(transactionId), 0, null, 2, base64(records),
                sha256(records), List.of(new CommitResource(resourceId,
                        "managed-monitor_run", 1, body.length,
                        sha256(body), Base64.getEncoder()
                                .encodeToString(body))));
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

    private static byte[] bytes(JsonNode node) {
        try {
            return JSON.writeValueAsBytes(node);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
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
