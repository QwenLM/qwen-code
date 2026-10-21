package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/** Discovers committed wake inputs independently of their source relay or MQ notice. */
@Repository
public class WakeRecoveryStore {
    private static final Set<String> SOURCES = Set.of("monitor", "channel", "child_agent",
            "workflow", "automation", "session_message");
    private static final int JOURNAL_PAGE = 1;
    private static final int PROOF_PAGES = 32;
    private static final long RETRY_MS = 30_000;
    private static final String UNOWNED = " (h.state = 'SEALED' OR (h.state = 'ACTIVE'"
            + " AND (h.writer_lease_until IS NULL OR h.writer_lease_until <= " + ManagedSchemaTime.SQL_NOW + ")))";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final LinkedHashMap<Candidate, Proof> pendingProofs = new LinkedHashMap<>(128, 0.75f, true);

    public WakeRecoveryStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        transactions = new TransactionTemplate(new DataSourceTransactionManager(Objects.requireNonNull(jdbc.getDataSource())));
    }

    public record Candidate(String tenantId, String workspaceId, String sessionId,
            long journalRevision, long committedSequence, long compactedThroughRevision,
            String parentSessionId, String parentChildRunId) {
    }

    private record Chunk(String workspaceId, long revision, long firstSequence,
            long lastSequence, int eventCount, String encoding, byte[] bytes,
            long byteLength, String digest) {
    }

    private static final class Proof {
        private final Set<String> pending = new HashSet<>();
        private final Set<String> settled = new HashSet<>();
        private long revision;
        private long sequence;
        private boolean complete;
    }

    public List<Candidate> findPending(String defaultWorkspace, int limit) {
        List<Candidate> candidates = new ArrayList<>(findPending(defaultWorkspace, limit, true));
        if (candidates.size() < limit) {
            candidates.addAll(findPending(defaultWorkspace, limit - candidates.size(), false));
        }
        return candidates;
    }

    private List<Candidate> findPending(String defaultWorkspace, int limit, boolean hinted) {
        return jdbc.query("SELECT h.tenant_id, h.workspace_id, h.session_id, h.journal_revision,"
                        + " h.committed_sequence, h.compacted_through_revision, s.parent_session_id,"
                        + " s.parent_child_run_id FROM ma_session_head h JOIN ma_session s ON"
                        + " s.tenant_id = h.tenant_id AND s.session_id = h.session_id WHERE"
                        + " h.head_kind = 'MANAGED_SESSION' AND h.wake_scan_pending = TRUE"
                        + " AND h.compacted_through_revision = 0"
                        + " AND h.wake_pending = ? AND h.wake_retry_at <= " + ManagedSchemaTime.SQL_NOW + " AND" + UNOWNED
                        + " AND s.session_kind = 'PUBLIC' AND s.status = 'ACTIVE'"
                        + " AND s.retired_at IS NULL AND s.csi_guard = FALSE"
                        + " AND h.workspace_id = COALESCE(s.workspace_id, ?)"
                        + " ORDER BY h.wake_retry_at, h.tenant_key, h.harness_key LIMIT ?",
                (row, index) -> new Candidate(row.getString("tenant_id"), row.getString("workspace_id"),
                        row.getString("session_id"), row.getLong("journal_revision"),
                        row.getLong("committed_sequence"), row.getLong("compacted_through_revision"),
                        row.getString("parent_session_id"), row.getString("parent_child_run_id")),
                hinted, defaultWorkspace, limit);
    }

    /** A durable delay survives a failed load or a process dying after this claim. */
    public boolean claim(Candidate candidate) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            // Match admission/lifecycle's Session-before-head lock order. An UPDATE
            // subquery would first lock the head, then wait for a shared Session lock.
            var session = jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                            + " AND session_id = ? AND session_kind = 'PUBLIC' AND status = 'ACTIVE'"
                            + " AND retired_at IS NULL AND csi_guard = FALSE"
                            + " AND (workspace_id IS NULL OR workspace_id = ?) FOR UPDATE",
                    String.class, candidate.tenantId(), candidate.sessionId(), candidate.workspaceId());
            if (session.isEmpty()) {
                return false;
            }
            return jdbc.update("UPDATE ma_session_head h SET wake_retry_at = " + ManagedSchemaTime.SQL_NOW + " + " + RETRY_MS + " WHERE"
                        + " h.tenant_key = ? AND h.harness_key = ? AND h.tenant_id = ?"
                        + " AND h.session_id = ? AND h.workspace_id = ?"
                        + " AND h.head_kind = 'MANAGED_SESSION' AND h.journal_revision = ?"
                        + " AND h.compacted_through_revision = 0"
                        + " AND h.wake_scan_pending = TRUE AND h.wake_retry_at <= " + ManagedSchemaTime.SQL_NOW + " AND" + UNOWNED,
                ManagedSchemaKeys.key(candidate.tenantId()),
                ManagedSchemaKeys.key(candidate.sessionId()), candidate.tenantId(), candidate.sessionId(),
                candidate.workspaceId(), candidate.journalRevision()) == 1;
        }));
    }

    /** An empty result yields a partial proof without certifying consumption. */
    public synchronized Optional<Boolean> hasPendingInput(Candidate candidate) {
        if (candidate.compactedThroughRevision() != 0) {
            throw corrupt();
        }
        pendingProofs.keySet().removeIf(old -> !old.equals(candidate)
                && old.tenantId().equals(candidate.tenantId())
                && old.workspaceId().equals(candidate.workspaceId())
                && old.sessionId().equals(candidate.sessionId()));
        var proof = pendingProofs.remove(candidate);
        if (proof != null && proof.complete) {
            pendingProofs.put(candidate, proof);
            return Optional.of(true);
        }
        if (proof == null) {
            proof = new Proof();
        }
        Set<String> pending = proof.pending;
        Set<String> settled = proof.settled;
        long revision = proof.revision;
        long sequence = proof.sequence;
        for (int pages = 0; revision < candidate.journalRevision() && pages < PROOF_PAGES; pages++) {
            List<Chunk> page = jdbc.query("SELECT workspace_id, journal_revision, first_sequence,"
                            + " last_sequence, event_count, record_encoding, record_bytes, byte_length,"
                            + " record_digest FROM ma_session_journal_tx WHERE tenant_id = ?"
                            + " AND session_id = ? AND journal_revision > ? AND journal_revision <= ?"
                            + " ORDER BY journal_revision LIMIT ?",
                    (row, index) -> new Chunk(row.getString("workspace_id"), row.getLong("journal_revision"),
                            row.getLong("first_sequence"), row.getLong("last_sequence"), row.getInt("event_count"),
                            row.getString("record_encoding"), row.getBytes("record_bytes"),
                            row.getLong("byte_length"), row.getString("record_digest")),
                    candidate.tenantId(), candidate.sessionId(), revision, candidate.journalRevision(), JOURNAL_PAGE);
            if (page.isEmpty()) {
                throw corrupt();
            }
            for (Chunk chunk : page) {
                if (chunk.revision() != ++revision || !candidate.workspaceId().equals(chunk.workspaceId())
                        || !"identity".equals(chunk.encoding()) || chunk.bytes() == null
                        || chunk.bytes().length != chunk.byteLength()
                        || chunk.byteLength() < 1
                        || chunk.byteLength() > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES
                        || !DigestUtils.sha256Hex(chunk.bytes()).equals(chunk.digest())
                        || chunk.eventCount() < 0
                        || chunk.eventCount() > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS) {
                    throw corrupt();
                }
                String[] lines = new String(chunk.bytes(), StandardCharsets.UTF_8).split("\n");
                if (lines.length < chunk.eventCount()
                        || chunk.eventCount() > 0 && chunk.firstSequence() != sequence + 1) {
                    throw corrupt();
                }
                for (int index = 0; index < chunk.eventCount(); index++) {
                    JsonNode record = ManagedExtensionRecordStore.parse(lines[index]);
                    JsonNode event = record == null ? null : record.get("managedSession");
                    if (event == null || !"managed_session_event_v1".equals(record.path("subtype").asText())
                            || !event.path("v").isIntegralNumber() || event.path("v").intValue() != 1
                            || !event.path("sequence").isIntegralNumber()
                            || event.path("sequence").longValue() != ++sequence
                            || !candidate.tenantId().equals(event.path("sessionKey").path("tenantId").asText())
                            || !candidate.workspaceId().equals(event.path("sessionKey").path("workspaceId").asText())
                            || !candidate.sessionId().equals(event.path("sessionKey").path("sessionId").asText())) {
                        throw corrupt();
                    }
                    String turnId = event.path("payload").path("turnId").textValue();
                    if ("turn.settled".equals(event.path("kind").asText())) {
                        if (turnId == null || turnId.isEmpty()) {
                            throw corrupt();
                        }
                        settled.add(turnId);
                        pending.remove(turnId);
                    } else if (isWakeInput(event)) {
                        if (turnId == null || turnId.isEmpty()) {
                            throw corrupt();
                        }
                        if (!settled.contains(turnId)) {
                            pending.add(turnId);
                        }
                    }
                }
                if (chunk.lastSequence() != sequence) {
                    throw corrupt();
                }
            }
        }
        proof.revision = revision;
        proof.sequence = sequence;
        if (revision == candidate.journalRevision()) {
            if (sequence != candidate.committedSequence()) {
                throw corrupt();
            }
            if (pending.isEmpty()) {
                return Optional.of(false);
            }
            proof.complete = true;
            pending.clear();
            settled.clear();
        }
        // The complete Candidate fences every continuation to the same immutable
        // prefix. Losing it restarts proof at zero; it never clears a durable hint.
        if (pendingProofs.size() == 128) {
            var completed = pendingProofs.entrySet().stream()
                    .filter(entry -> entry.getValue().complete).findFirst();
            if (completed.isPresent()) {
                pendingProofs.remove(completed.get().getKey());
            } else {
                var oldest = pendingProofs.firstEntry().getKey();
                if (!canResume(oldest)) {
                    pendingProofs.remove(oldest);
                } else {
                    // Rotate cleanup without evicting a live continuation: otherwise
                    // a backlog larger than the cache can restart every proof forever.
                    pendingProofs.get(oldest);
                    return proof.complete ? Optional.of(true) : Optional.empty();
                }
            }
        }
        pendingProofs.put(candidate, proof);
        return proof.complete ? Optional.of(true) : Optional.empty();
    }

    private boolean canResume(Candidate candidate) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head h JOIN ma_session s ON"
                        + " s.tenant_id = h.tenant_id AND s.session_id = h.session_id"
                        + " WHERE h.tenant_key = ? AND h.harness_key = ? AND h.tenant_id = ?"
                        + " AND h.session_id = ? AND h.workspace_id = ? AND h.head_kind = 'MANAGED_SESSION'"
                        + " AND h.journal_revision = ? AND h.committed_sequence = ?"
                        + " AND h.compacted_through_revision = 0 AND h.wake_scan_pending = TRUE AND" + UNOWNED
                        + " AND s.session_kind = 'PUBLIC' AND s.status = 'ACTIVE'"
                        + " AND s.retired_at IS NULL AND s.csi_guard = FALSE"
                        + " AND (s.workspace_id IS NULL OR s.workspace_id = ?)",
                Long.class, ManagedSchemaKeys.key(candidate.tenantId()), ManagedSchemaKeys.key(candidate.sessionId()),
                candidate.tenantId(), candidate.sessionId(), candidate.workspaceId(), candidate.journalRevision(),
                candidate.committedSequence(), candidate.workspaceId()) == 1;
    }

    /** Only a full prefix at this exact revision may clear the hint. */
    public boolean recordPending(Candidate candidate, boolean pending) {
        return jdbc.update("UPDATE ma_session_head SET wake_pending = ?, wake_head_revision = ?"
                        + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND workspace_id = ? AND journal_revision = ?"
                        + " AND compacted_through_revision = 0",
                pending, candidate.journalRevision(), ManagedSchemaKeys.key(candidate.tenantId()),
                ManagedSchemaKeys.key(candidate.sessionId()), candidate.tenantId(), candidate.sessionId(),
                candidate.workspaceId(), candidate.journalRevision()) == 1;
    }

    static boolean isWakeInput(JsonNode event) {
        return "input.accepted".equals(event.path("kind").asText())
                && SOURCES.contains(event.path("payload").path("source").asText());
    }

    private static IllegalStateException corrupt() {
        return new IllegalStateException("Wake recovery cannot prove the complete committed Session journal");
    }
}
