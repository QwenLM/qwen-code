package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class JournalHistoryQueries {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final JdbcTemplate jdbc;

    JournalHistoryQueries(JournalFencing fencing,
            JournalStoreRows storeRows,
            JdbcTemplate jdbc) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
    }

    static final RequestDigests INITIAL_DIGESTS = new RequestDigests();

    RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        fencing.requireCredential(tenantId, workspaceId, sessionId, writerToken);
        JournalStoreRows.HeadRow head = storeRows.requireHead(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, workspaceId, sessionId);
        fencing.requireReadGrant(head, writerToken);
        return storeRows.restoreHead(head);
    }

    TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit) {
        JournalStoreRows.validateScope(tenantId, workspaceId, sessionId);
        fencing.requireCredential(tenantId, workspaceId, sessionId, writerToken);
        if (afterRevision < 0
                || afterRevision > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || limit < 1 || limit > 100) {
            throw JournalStoreRows.invalid("afterRevision and limit are outside their bounds.");
        }
        JournalStoreRows.HeadRow head = storeRows.requireHead(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, workspaceId, sessionId);
        fencing.requireReadGrant(head, writerToken);
        List<TransactionSize> candidates = jdbc.query(
                "SELECT journal_revision, byte_length"
                        + " FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND journal_revision > ?"
                        + " ORDER BY journal_revision LIMIT ?",
                (result, row) -> new TransactionSize(
                        result.getLong("journal_revision"),
                        result.getLong("byte_length")),
                tenantId, sessionId, afterRevision,
                limit + 1);
        int selectedCount = 0;
        long selectedBytes = 0;
        long expectedRevision = afterRevision + 1;
        for (TransactionSize candidate : candidates) {
            if (candidate.journalRevision() != expectedRevision
                    || candidate.journalRevision()
                            > head.journalRevision()
                    || candidate.byteLength() < 1 || candidate.byteLength()
                    > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                throw JournalStoreRows.journalCorrupt();
            }
            expectedRevision++;
            if (selectedCount == limit || selectedCount > 0
                    && selectedBytes + candidate.byteLength()
                            > ManagedSessionStoreModels
                                    .MAX_TRANSACTION_BYTES) {
                break;
            }
            selectedBytes += candidate.byteLength();
            selectedCount++;
        }
        if (afterRevision < head.journalRevision()
                && (candidates.isEmpty()
                        || candidates.size() < limit + 1
                                && candidates.get(candidates.size() - 1)
                                        .journalRevision()
                                        != head.journalRevision())) {
            throw JournalStoreRows.journalCorrupt();
        }
        List<JournalStoreRows.TransactionRow> rows = selectedCount == 0 ? List.of()
                : jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + ""
                                + " FROM ma_session_journal_tx"
                                + " WHERE tenant_id = ? AND session_id = ?"
                                + " AND journal_revision > ?"
                                + " ORDER BY journal_revision LIMIT ?",
                        storeRows.transactionMapper, tenantId, sessionId,
                        afterRevision, selectedCount);
        if (rows.size() != selectedCount) {
            throw JournalStoreRows.journalCorrupt();
        }
        for (int index = 0; index < rows.size(); index++) {
            JournalStoreRows.TransactionRow row = rows.get(index);
            TransactionSize candidate = candidates.get(index);
            if (row.journalRevision() != candidate.journalRevision()
                    || row.byteLength() != candidate.byteLength()) {
                throw JournalStoreRows.journalCorrupt();
            }
        }
        boolean hasMore = candidates.size() > selectedCount;
        rows.forEach(row -> JournalStoreRows.requireTransactionWorkspace(row, workspaceId));
        List<StoredTransaction> transactions = rows.stream()
                .map(storeRows::storedTransaction).toList();
        long nextRevision = transactions.isEmpty() ? afterRevision
                : transactions.get(transactions.size() - 1)
                        .journalRevision();
        return new TransactionPage(transactions, nextRevision, hasMore);
    }

    ManagedSessionStoreModels.RecentTransactionPage recentTransactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, Long beforeRevision, int limit) {
        long through = historyRevision(tenantId, workspaceId, sessionId, writerToken, throughRevision);
        if (limit < 1 || limit > 100 || beforeRevision != null && (beforeRevision < 1 || beforeRevision > through)) {
            throw JournalStoreRows.invalid("History page position or limit is outside its bounds.");
        }
        long upper = beforeRevision == null ? through : beforeRevision - 1;
        List<TransactionSize> candidates = jdbc.query("SELECT journal_revision, byte_length FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND journal_revision <= ?"
                        + " ORDER BY journal_revision DESC LIMIT ?",
                (row, index) -> new TransactionSize(row.getLong("journal_revision"), row.getLong("byte_length")),
                tenantId, sessionId, upper, limit + 1);
        int selected = 0;
        long bytes = 0;
        long expected = upper;
        for (TransactionSize candidate : candidates) {
            if (candidate.journalRevision() != expected-- || candidate.byteLength() < 1
                    || candidate.byteLength() > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                throw JournalStoreRows.journalCorrupt();
            }
            if (selected == limit || selected > 0 && bytes + candidate.byteLength()
                    > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                break;
            }
            bytes += candidate.byteLength();
            selected++;
        }
        if (upper > 0 && (candidates.isEmpty() || candidates.size() < limit + 1
                && candidates.getLast().journalRevision() != 1)) {
            throw JournalStoreRows.journalCorrupt();
        }
        List<JournalStoreRows.TransactionRow> rows = selected == 0 ? List.of() : jdbc.query(
                "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND journal_revision <= ?"
                        + " ORDER BY journal_revision DESC LIMIT ?", storeRows.transactionMapper, tenantId, sessionId, upper, selected);
        if (rows.size() != selected) {
            throw JournalStoreRows.journalCorrupt();
        }
        List<StoredTransaction> transactions = new ArrayList<>();
        for (int index = 0; index < rows.size(); index++) {
            JournalStoreRows.TransactionRow row = rows.get(index);
            if (row.journalRevision() != candidates.get(index).journalRevision()
                    || row.byteLength() != candidates.get(index).byteLength()) {
                throw JournalStoreRows.journalCorrupt();
            }
            JournalStoreRows.requireTransactionWorkspace(row, workspaceId);
            transactions.add(storeRows.storedTransaction(row));
        }
        boolean more = candidates.size() > selected;
        Long next = more ? transactions.getLast().journalRevision() : null;
        java.util.Collections.reverse(transactions);
        restore(tenantId, workspaceId, sessionId, writerToken);
        return new ManagedSessionStoreModels.RecentTransactionPage(List.copyOf(transactions), through, next, more);
    }

    ManagedSessionStoreModels.CommandTransaction commandTransaction(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, String operation, String commandId) {
        long through = historyRevision(tenantId, workspaceId, sessionId, writerToken, throughRevision);
        if (StringUtils.isBlank(operation) || operation.length() > 4096
                || StringUtils.isBlank(commandId) || commandId.length() > 512) {
            throw JournalStoreRows.invalid("History command identity is invalid.");
        }
        String key = JournalStoreRows.commandKeyHash(operation, commandId);
        var sizes = jdbc.query("SELECT journal_revision, byte_length FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND command_key_hash = ? AND journal_revision <= ?",
                (row, index) -> new TransactionSize(row.getLong("journal_revision"), row.getLong("byte_length")),
                tenantId, sessionId, key, through);
        StoredTransaction transaction = null;
        if (!sizes.isEmpty()) {
            TransactionSize size = sizes.getFirst();
            if (sizes.size() != 1 || size.byteLength() < 1
                    || size.byteLength() > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                throw JournalStoreRows.journalCorrupt();
            }
            JournalStoreRows.TransactionRow row = storeRows.findTransactionByCommand(tenantId, sessionId, key);
            if (row == null || row.journalRevision() != size.journalRevision() || row.byteLength() != size.byteLength()) {
                throw JournalStoreRows.journalCorrupt();
            }
            JournalStoreRows.requireTransactionWorkspace(row, workspaceId);
            if (!operation.equals(row.operation()) || !commandId.equals(row.commandId())
                    || row.byteLength() < 1 || row.byteLength() > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                throw JournalStoreRows.journalCorrupt();
            }
            transaction = storeRows.storedTransaction(row);
        }
        restore(tenantId, workspaceId, sessionId, writerToken);
        return new ManagedSessionStoreModels.CommandTransaction(through, transaction);
    }

    long historyRevision(String tenantId, String workspaceId, String sessionId, String writerToken,
            Long throughRevision) {
        RestoreHead head = restore(tenantId, workspaceId, sessionId, writerToken);
        if (head.compactedThroughRevision() != 0) {
            throw JournalStoreRows.conflict(ManagedSessionStoreModels.ERROR_RECOVERY_CONFLICT, "History prefix is no longer retained.");
        }
        if (throughRevision != null && (throughRevision < 0
                || throughRevision > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || throughRevision > head.journalRevision())) {
            throw JournalStoreRows.invalid("History prefix is outside its committed bounds.");
        }
        long through = throughRevision == null ? head.journalRevision() : throughRevision;
        if (through > 0) {
            var prefix = jdbc.query("SELECT workspace_id FROM ma_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                    (row, index) -> row.getString("workspace_id"), tenantId, sessionId, through);
            if (prefix.size() != 1 || !workspaceId.equals(prefix.getFirst())) {
                throw JournalStoreRows.journalCorrupt();
            }
        }
        return through;
    }

    /** Proves only an untouched initial journal; it never opens or fences a writer. */
    boolean hasPristineInitialJournal(String tenantId, String sessionId, String workspaceId) {
        try {
            JournalStoreRows.HeadRow head = storeRows.requireHead(tenantId, sessionId);
            if (!Set.of("ACTIVE", "SEALED").contains(head.state())
                    || !"READY".equals(head.recoveryStatus()) || head.storageVersion() != JournalStoreRows.STORAGE_VERSION
                    || head.compactedThroughRevision() != 0 || head.latestCheckpointResourceId() != null
                    || head.journalRevision() < 1 || head.committedSequence() < 0
                    || workspaceId != null && !workspaceId.equals(head.workspaceId())) {
                return false;
            }
            var rows = jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns()
                            + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                            + " ORDER BY journal_revision", storeRows.transactionMapper, tenantId, sessionId);
            long revision = 0;
            long sequence = 0;
            long activationEpoch = 0;
            String digest = null;
            for (JournalStoreRows.TransactionRow row : rows) {
                if (row.journalRevision() != ++revision || !head.workspaceId().equals(row.workspaceId())
                        || row.latestCheckpointResourceId() != null || row.activationEpoch() < activationEpoch
                        || !Objects.equals(digest, row.previousCommitDigest())) {
                    return false;
                }
                storeRows.storedTransaction(row);
                JournalStoreRows.validateUtf8JsonLines(row.recordBytes(), revision == 1 ? 2 : row.eventCount() + 1);
                String[] lines = new String(row.recordBytes(), StandardCharsets.UTF_8).split("\n");
                if (revision == 1) {
                    if (!"session.create".equals(row.operation()) || row.eventCount() != 0
                            || row.firstSequence() != 0 || row.lastSequence() != 0 || lines.length != 2
                            || row.commitDigest() != null || row.eventsDigest() != null || row.activationEpoch() != 0
                            || !("session.create:" + sessionId).equals(row.transactionId())
                            || !row.transactionId().equals(row.commandId())
                            || !row.recordDigest().equals(row.contentDigest())) {
                        return false;
                    }
                    JsonNode engine = JournalStoreRows.CSI_TERMINAL_JSON.readTree(lines[0]);
                    JsonNode header = JournalStoreRows.CSI_TERMINAL_JSON.readTree(lines[1]);
                    JsonNode value = header.path("managedSession");
                    requireInitialResource(value.path("definitionRef"), head, "managed-definition");
                    requireInitialResource(value.path("rootSnapshotRef"), head, "managed-root");
                    if (!"session_execution_engine".equals(engine.path("subtype").asText())
                            || !"managed".equals(engine.path("systemPayload").path("engine").asText())
                            || !sessionId.equals(engine.path("sessionId").asText())
                            || !"managed_session_header_v1".equals(header.path("subtype").asText())
                            || !sessionId.equals(header.path("sessionId").asText())
                            || value.size() != 7 || value.path("formatVersion").asInt() != JournalStoreRows.STORAGE_VERSION
                            || !"managed-session/1".equals(value.path("minimumReader").asText())
                            || !"managed".equals(value.path("engine").asText())
                            || !"hosted-harness".equals(value.path("createdBy").asText())
                            || value.has("baseTranscriptProof") || !initialScope(value, head)) {
                        return false;
                    }
                } else {
                    if (row.eventCount() < 1 || lines.length != row.eventCount() + 1
                            || row.firstSequence() != sequence + 1
                            || row.lastSequence() != sequence + row.eventCount() || row.commitDigest() == null) {
                        return false;
                    }
                    var events = JournalStoreRows.CSI_JSON.createArrayNode();
                    boolean activationChanged = false;
                    for (int index = 0; index < row.eventCount(); index++) {
                        JsonNode record = JournalStoreRows.CSI_TERMINAL_JSON.readTree(lines[index]);
                        JsonNode event = record.path("managedSession");
                        JsonNode payload = event.path("payload");
                        String kind = event.path("kind").asText();
                        if (!sessionId.equals(record.path("sessionId").asText())
                                || !"managed_session_event_v1".equals(record.path("subtype").asText())
                                || event.path("v").asInt() != JournalStoreRows.STORAGE_VERSION
                                || event.path("sequence").asLong(-1) != ++sequence || !initialScope(event, head)
                                || !("activation.changed".equals(kind)
                                        && "activation".equals(payload.path("subject").path("type").asText())
                                        && payload.path("activationId").isTextual()
                                        && payload.path("activationId").equals(payload.path("subject").path("scopeId"))
                                        && payload.path("activationId").equals(payload.path("subject").path("activationId"))
                                        && payload.path("epoch").equals(payload.path("subject").path("epoch"))
                                        && payload.path("epoch").asLong() > 0
                                        && payload.path("epoch").asLong() == row.activationEpoch()
                                        || "domain.committed".equals(kind)
                                                && "session_metadata".equals(payload.path("domain").asText()))) {
                            return false;
                        }
                        if ("domain.committed".equals(kind)) {
                            requireInitialResource(payload.path("recordRef"), head, "managed-session_metadata");
                        } else {
                            activationChanged = true;
                            if (!payload.path("installRef").isNull()) {
                                requireInitialResource(payload.path("installRef"), head, "managed-activation-install");
                            }
                            if (!payload.path("boundaryRef").isNull()) {
                                requireInitialResource(payload.path("boundaryRef"), head, "managed-activation-boundary");
                            }
                        }
                        events.add(event);
                    }
                    if (!activationChanged && row.activationEpoch() != activationEpoch) {
                        return false;
                    }
                    JsonNode markerRecord = JournalStoreRows.CSI_TERMINAL_JSON.readTree(lines[lines.length - 1]);
                    JsonNode marker = markerRecord.path("managedSession");
                    if (!"managed_session_commit_v1".equals(markerRecord.path("subtype").asText())
                            || !sessionId.equals(markerRecord.path("sessionId").asText())
                            || !row.transactionId().equals(marker.path("transactionId").asText())
                            || !row.commandId().equals(marker.path("commandId").asText())
                            || !row.operation().equals(marker.path("operation").asText())
                            || !row.contentDigest().equals(marker.path("contentDigest").asText())
                            || row.firstSequence() != marker.path("firstSequence").asLong(-1)
                            || row.lastSequence() != marker.path("lastSequence").asLong(-1)
                            || row.eventCount() != marker.path("eventCount").asInt(-1)
                            || !row.eventsDigest().equals(marker.path("eventsDigest").asText())
                            || !INITIAL_DIGESTS.digest(JournalStoreRows.CSI_JSON.convertValue(events, Object.class))
                                    .equals("sha256:" + row.eventsDigest())
                            || !INITIAL_DIGESTS.digest(JournalStoreRows.CSI_JSON.convertValue(marker, Object.class))
                                    .equals("sha256:" + row.commitDigest())
                            || !Objects.equals(digest, marker.path("previousCommitDigest").isNull()
                                    ? null : marker.path("previousCommitDigest").asText())) {
                        return false;
                    }
                }
                digest = row.commitDigest();
                activationEpoch = row.activationEpoch();
            }
            return revision == head.journalRevision() && sequence == head.committedSequence()
                    && activationEpoch == head.activationEpoch()
                    && Objects.equals(digest, head.lastCommitDigest()) && head.equals(storeRows.requireHead(tenantId, sessionId));
        } catch (IOException | RuntimeException unverified) {
            return false;
        }
    }

    static boolean initialScope(JsonNode value, JournalStoreRows.HeadRow head) {
        JsonNode key = value.path("sessionKey");
        return head.tenantId().equals(key.path("tenantId").asText())
                && head.workspaceId().equals(key.path("workspaceId").asText())
                && head.sessionId().equals(key.path("sessionId").asText());
    }

    void requireInitialResource(JsonNode ref, JournalStoreRows.HeadRow head, String kind) throws IOException {
        WorkspaceRecoveryReader.validateRef(ref);
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(head.tenantId(), head.sessionId());
        var resources = jdbc.query("SELECT " + ManagedSchemaProjection.RESOURCE.columns()
                        + " FROM ma_resource WHERE resource_key = ? AND session_scope_key = ? AND resource_id = ?",
                storeRows.resourceMapper, com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, ref.path("resourceId").asText()), scope, ref.path("resourceId").asText());
        if (resources.size() != 1) {
            throw JournalStoreRows.journalCorrupt();
        }
        JournalStoreRows.ResourceRow resource = resources.getFirst();
        JournalStoreRows.requireResourceScope(resource, head.tenantId(), head.workspaceId(), head.sessionId(), ref.path("resourceId").asText());
        if (!"MYSQL_INLINE".equals(resource.storageKind()) || !kind.equals(resource.kind())
                || !kind.equals(ref.path("kind").asText()) || resource.schemaVersion() != ref.path("schemaVersion").asInt()
                || resource.byteLength() != ref.path("byteLength").asLong() || !resource.digest().equals(ref.path("digest").asText())) {
            throw JournalStoreRows.journalCorrupt();
        }
        storeRows.verifyStoredResource(resource);
        if ("managed-definition".equals(kind)) {
            JsonNode definition = JournalStoreRows.CSI_TERMINAL_JSON.readTree(resource.bytes());
            if (definition == null || !definition.isObject()) {
                throw JournalStoreRows.journalCorrupt();
            }
        }
    }

    record TransactionSize(long journalRevision, long byteLength) {
    }
}
