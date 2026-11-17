package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Base64;
import java.util.List;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.text;

/**
 * The committed journal evidence a publication grant must name, split out of the
 * publication store along the evidence seam: the activation the writer holds,
 * the tool.intent event at its own revision, and the checkpoint and argument
 * resources that authorize the dispatch. The original execution is locked by the
 * store, so the lock order the caller established is unchanged.
 */
final class ToolPublicationEvidence {
    private final JdbcTemplate jdbc;
    private final JdbcManagedSessionStore sessions;
    private final ToolPublicationStore store;

    ToolPublicationEvidence(JdbcTemplate jdbc, JdbcManagedSessionStore sessions,
            ToolPublicationStore store) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.store = store;
    }

    long requireEvidence(JsonNode b, String writerToken, JdbcManagedSessionStore.PublicationWriter writer,
            boolean preparing) {
        JsonNode key = b.get("sessionKey");
        require("READY".equals(writer.recoveryStatus()), "Session recovery is blocked");
        require(writer.activationEpoch() == b.get("activationEpoch").longValue()
                && writer.checkpointId() != null, "Checkpoint or activation changed");
        require(writer.activationHeadRevision() != null
                && writer.activationHeadRevision() == writer.journalRevision()
                && "active".equals(writer.activationPhase())
                && text(b, "activationId").equals(writer.activationId())
                && writer.activationEventEpoch() != null
                && b.get("activationEpoch").longValue() == writer.activationEventEpoch()
                && writer.activationExpiresAt() != null
                && writer.activationExpiresAt() > writer.now(), "Activation is not active");
        long activationExpiresAt = writer.activationExpiresAt();
        JsonNode intent = readIntent(b, key, writerToken, b.get("intentSequence").longValue(), writer);
        JsonNode payload = intent.path("payload");
        require(text(b, "executionCallId").equals(text(payload, "executionCallId"))
                && b.get("argsRef").equals(payload.path("argsRef"))
                && "runtime".equals(text(payload, "outcomeSource"))
                && "activation".equals(text(intent.path("subject"), "type"))
                && text(b, "activationId").equals(text(intent.path("subject"), "activationId"))
                && b.get("activationEpoch").longValue() == intent.path("subject").path("epoch").asLong(),
                "Original intent conflicts");
        requireCheckpoint(b, readResource(b, b.get("checkpointRef"), writerToken), writer);
        if (!writer.checkpointId().equals(text(b.get("checkpointRef"), "resourceId"))) {
            var current = sessions.readResource(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), writer.checkpointId(), writerToken);
            require("managed-checkpoint".equals(current.kind()) && current.schemaVersion() == 1
                    && current.byteLength() <= ManagedSessionStoreModels.MAX_EVENT_BYTES, "Current checkpoint is invalid");
            requireCheckpoint(b, ToolPublicationContract.readJson(current.bytes()), writer);
        }
        JsonNode args = readResource(b, b.get("argsRef"), writerToken);
        require(text(key, "sessionId").equals(text(args, "harnessSessionId"))
                && text(b.get("reference"), "sessionId").equals(text(args, "runtimeSessionId")),
                "Argument resource scope conflicts");
        ToolPublicationContract.requirePayload(b, text(args, "payloadJson"));
        ToolExecutionRecord execution = store.liveExecution(b);
        if (preparing) {
            require(execution.getState() == ToolExecutionRecord.State.PREPARED && execution.getDispatchGeneration() == 0,
                    "Publication must be reserved before dispatch");
        }
        return Math.min(writer.leaseUntil(), activationExpiresAt);
    }

    /**
     * Reads the tool.intent event at the revision its sequence belongs to, keeping the scan's
     * fail-closed checks: the located revision's page must be exactly that revision, and the
     * revisions above it up to the locked head must be gap-free.
     */
    private JsonNode readIntent(JsonNode b, JsonNode key, String writerToken,
            long intentSequence,
            JdbcManagedSessionStore.PublicationWriter writer) {
        long headRevision = writer.journalRevision();
        String tenant = text(key, "tenantId");
        String session = text(key, "sessionId");
        List<Long> revisions = jdbc.queryForList(
                "SELECT journal_revision FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND first_sequence <= ? AND last_sequence >= ?"
                        + " AND journal_revision <= ?",
                Long.class, tenant, session, intentSequence, intentSequence,
                headRevision);
        // An ambiguous range or a hole inside the committed span means
        // server-side journal damage: the session store's corruption fault
        // (500). A sequence beyond the committed span means the binding
        // names evidence that was never committed — a client request fault.
        if (revisions.size() > 1) {
            throw JdbcManagedSessionStore.journalCorrupt();
        }
        if (revisions.isEmpty()) {
            if (intentSequence > writer.committedSequence()) {
                // The binding names evidence that was never committed —
                // the requester's fault, not the journal's.
                throw new IllegalArgumentException(
                        "Committed publication evidence is missing");
            }
            throw JdbcManagedSessionStore.journalCorrupt();
        }
        long revision = revisions.get(0);
        // The committed revisions above the intent must be contiguous
        // and retain their bounded byte lengths.
        Long above = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_session_journal_tx WHERE tenant_id = ?"
                        + " AND session_id = ? AND journal_revision > ?"
                        + " AND journal_revision <= ?"
                        + " AND byte_length >= 1 AND byte_length <= ?",
                Long.class, tenant, session, revision, headRevision,
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
        if (above == null || above != headRevision - revision) {
            throw JdbcManagedSessionStore.journalCorrupt();
        }
        var page = sessions.transactions(tenant, text(key, "workspaceId"),
                session, writerToken, revision - 1, 1);
        if (page.transactions().size() != 1
                || page.transactions().get(0).journalRevision() != revision) {
            throw JdbcManagedSessionStore.journalCorrupt();
        }
        byte[] bytes = Base64.getDecoder().decode(
                page.transactions().get(0).recordBytesBase64());
        JsonNode intent = null;
        int offset = 0;
        while (offset < bytes.length) {
            int end = offset;
            while (end < bytes.length && bytes[end] != '\n') {
                end++;
            }
            JsonNode record = ToolPublicationContract.readJson(bytes, offset,
                    end - offset);
            offset = end + 1;
            if (!"managed_session_event_v1".equals(text(record, "subtype"))) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            require(event.path("sessionKey").equals(key)
                    && event.path("v").asInt() == 1,
                    "Journal event scope conflicts");
            if (event.path("sequence").asLong() == intentSequence) {
                require("tool.intent".equals(text(event, "kind")),
                        "Intent sequence conflicts");
                require(page.transactions().get(0).writerGeneration()
                        == b.get("writerGeneration").longValue(),
                        "Original intent writer conflicts");
                require(intent == null, "Intent sequence conflicts");
                intent = event;
            }
        }
        require(intent != null, "Committed publication evidence is missing");
        return intent;
    }

    private static void requireCheckpoint(JsonNode b, JsonNode checkpoint, JdbcManagedSessionStore.PublicationWriter writer) {
        JsonNode key = b.get("sessionKey");
        long intentSequence = b.get("intentSequence").longValue();
        JsonNode identity = checkpoint.path("identity");
        require(identity.path("sessionKey").equals(key)
                && text(b, "turnId").equals(text(identity, "turnId"))
                && text(b.get("reference"), "promptId").equals(text(identity, "promptId"))
                && "managed".equals(text(identity, "engine")) && identity.path("schemaVersion").asInt() == 1
                && text(b, "activationId").equals(text(identity, "activationId"))
                && identity.path("coveredSequence").asLong() >= intentSequence
                && identity.path("coveredSequence").asLong() <= writer.committedSequence()
                && "await_runtime".equals(text(checkpoint.path("continuation"), "phase")),
                "Checkpoint does not authorize dispatch");
        JsonNode item = null;
        for (JsonNode value : checkpoint.path("tools").path("items")) {
            if (text(b, "executionCallId").equals(text(value, "executionCallId"))) {
                require(item == null, "Duplicate checkpoint execution");
                item = value;
            }
        }
        require(item != null
                && ToolPublicationContract.PUBLISHABLE_TOOL_NAMES.contains(text(item, "toolName"))
                && "in_progress".equals(text(item, "state"))
                && "runtime".equals(text(item, "outcomeSource"))
                && text(b, "modelCallId").equals(text(item, "functionCallId"))
                && text(b.path("reference"), "argsDigest")
                        .equals("sha256:" + text(item, "inputDigest")),
                "Checkpoint execution identity conflicts");
    }

    private JsonNode readResource(JsonNode b, JsonNode ref, String writerToken) {
        JsonNode key = b.get("sessionKey");
        var resource = sessions.readResource(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), text(ref, "resourceId"), writerToken);
        require(resource.kind().equals(text(ref, "kind")) && resource.schemaVersion() == ref.get("schemaVersion").intValue()
                && resource.byteLength() == ref.get("byteLength").longValue()
                && resource.digest().equals(text(ref, "digest")), "Publication resource reference conflicts");
        return ToolPublicationContract.readJson(resource.bytes());
    }
}
