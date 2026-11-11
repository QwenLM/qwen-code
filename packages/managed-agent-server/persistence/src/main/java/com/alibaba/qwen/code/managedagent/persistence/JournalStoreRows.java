package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

final class JournalStoreRows {
    private final com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion;
    private final JdbcTemplate jdbc;

    JournalStoreRows(com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion,
            JdbcTemplate jdbc) {
        this.readerVersion = readerVersion;
        this.jdbc = jdbc;
        this.headMapper = (result, row) ->
                new HeadRow(result.getString("tenant_id"),
                        result.getString("workspace_id"),
                        result.getString("session_id"),
                        result.getString("state"),
                        result.getInt("storage_version"),
                        result.getLong("writer_generation"),
                        result.getString("writer_id"),
                        ManagedSchemaTime.timestamp(result, "writer_lease_until"),
                        result.getString("lease_token_hash"),
                        result.getLong("journal_revision"),
                        result.getLong("committed_sequence"),
                        result.getString("last_commit_digest"),
                        result.getLong("activation_epoch"),
                        result.getString("latest_checkpoint_resource_id"),
                        result.getLong("compacted_through_revision"),
                        result.getLong("packed_through_revision"),
                        result.getString("recovery_status"),
                        result.getString("recovery_detail_code"),
                        result.getString("activation_id"),
                        result.getString("activation_phase"),
                        result.getObject("activation_event_epoch", Long.class),
                        result.getObject("activation_expires_at", Long.class),
                        result.getObject("activation_head_revision", Long.class));
        this.transactionMapper = (result, row) -> transactionRow(result);
        this.resourceMapper = (result, row) ->
                        new ResourceRow(
                                result.getString("tenant_id"),
                                result.getString("workspace_id"),
                                result.getString("session_id"),
                                result.getString("resource_id"),
                                result.getString("kind"),
                                result.getInt("schema_version"),
                                result.getLong("byte_length"),
                                result.getString("sha256"),
                                result.getString("storage_kind"),
                                result.getBytes("inline_bytes"),
                                result.getString("object_key"),
                                result.getString("object_version_id"),
                                result.getString("encryption_key_id"),
                                result.getString("state"),
                                result.getString("capture_state"),
                                result.getString("deletion_operation_key"));
    }

    static final int STORAGE_VERSION = 1;

    static final ObjectMapper CSI_JSON = new ObjectMapper();

    static final ObjectMapper CSI_TERMINAL_JSON = CSI_JSON.copy().enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(com.fasterxml.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT);

    static final int MAX_ID_BYTES = 512;

    static final int MAX_TEXT_BYTES = 4096;

    static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");

    static final Set<String> HEAD_STATES = Set.of(
            "ACTIVE", "SEALED", "DELETING", "DELETED");

    static final Set<String> RECOVERY_STATES = Set.of(
            "READY", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE",
            "BLOCKED_EXECUTION");

    final RowMapper<HeadRow> headMapper;

    final RowMapper<TransactionRow> transactionMapper;

    final RowMapper<ResourceRow> resourceMapper;

    boolean usesDataSource(javax.sql.DataSource source) {
        return source != null && jdbc.getDataSource() == source;
    }

    RestoreHead restoreHead(HeadRow head) {
        boolean renewed = "active".equals(head.activationPhase()) && !jdbc.queryForList(
                "SELECT 1 FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND activation_epoch = ? AND activation_lease_until IS NOT NULL LIMIT 1",
                head.tenantId(), head.sessionId(), head.activationEpoch()).isEmpty();
        var lease = renewed ? activationLeaseRow(head).lease() : null;
        return new RestoreHead(head.state(), head.storageVersion(),
                head.writerGeneration(), head.journalRevision(),
                head.committedSequence(), head.lastCommitDigest(),
                head.activationEpoch(), head.latestCheckpointResourceId(),
                head.compactedThroughRevision(), head.recoveryStatus(),
                head.recoveryDetailCode(), lease);
    }

    record ActivationLeaseRow(long revision, String workerId, ManagedSessionStoreModels.ActivationLease lease) {
    }

    ActivationLeaseRow activationLeaseRow(HeadRow head) {
        // Every activation renewal reads this row, three times a minute per
        // resident Session. Renewals update the activation row in place, so
        // without idx_ma_session_journal_tx_activation the lookup walked back
        // over every transaction the activation had committed.
        var rows = jdbc.query("SELECT journal_revision, record_bytes, record_digest, activation_lease_until,"
                        + " activation_renewal_seq FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND activation_epoch = ? AND is_activation_record = TRUE"
                        + " ORDER BY journal_revision DESC LIMIT 1", (result, index) -> {
                            try {
                                byte[] raw = result.getBytes("record_bytes");
                                if (raw == null || !sha256(raw).equals(result.getString("record_digest"))) {
                                    throw journalCorrupt();
                                }
                                String first = new String(raw, StandardCharsets.UTF_8).split("\n", 2)[0];
                                JsonNode event = CSI_TERMINAL_JSON.readTree(first).path("managedSession");
                                JsonNode payload = event.path("payload");
                                if (!"activation.changed".equals(event.path("kind").asText())
                                        || !"active".equals(payload.path("phase").asText())) {
                                    throw journalCorrupt();
                                }
                                long renewal = payload.path("renewalSeq").asLong(0);
                                long until = payload.path("expiresAt").asLong(-1);
                                Long savedUntil = result.getObject("activation_lease_until", Long.class);
                                Long savedRenewal = result.getObject("activation_renewal_seq", Long.class);
                                if ((savedUntil == null) != (savedRenewal == null)
                                        || savedUntil != null && (savedUntil < until || savedRenewal <= renewal
                                                || savedRenewal > ManagedSessionStoreModels.MAX_SAFE_COUNTER)) {
                                    throw journalCorrupt();
                                }
                                var lease = new ManagedSessionStoreModels.ActivationLease(
                                        payload.path("activationId").textValue(), payload.path("epoch").asLong(),
                                        savedRenewal == null ? renewal : savedRenewal,
                                        savedUntil == null ? until : savedUntil);
                                if (!Objects.equals(head.activationId(), lease.activationId())
                                        || !Objects.equals(head.activationEventEpoch(), lease.epoch())
                                        || !Objects.equals(head.activationExpiresAt(), lease.expiresAt())) {
                                    throw journalCorrupt();
                                }
                                return new ActivationLeaseRow(result.getLong("journal_revision"),
                                        payload.path("workerId").textValue(), lease);
                            } catch (java.io.IOException error) {
                                throw journalCorrupt();
                            }
                        }, head.tenantId(), head.sessionId(), head.activationEpoch());
        if (rows.size() != 1) {
            throw journalCorrupt();
        }
        return rows.getFirst();
    }

    static int toolResultLimit(String kind) {
        if (kind == null) {
            return 0;
        }
        return switch (kind) {
            case "managed-tool-result-content" -> 1024 * 1024;
            case "managed-tool-result-page" -> 256 * 1024;
            case "managed-tool-result-manifest" -> 64 * 1024;
            default -> 0;
        };
    }

    /** A committed resource of this transaction's Session, verified. */
    StoredResource storedResource(String scopeKey, String tenantId,
            String workspaceId, String sessionId, String resourceId) {
        ResourceRow resource = findResource(scopeKey, resourceId);
        if (resource == null) {
            throw conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "A referenced Managed Session resource is missing.");
        }
        requireResourceScope(resource, tenantId, workspaceId, sessionId,
                resourceId);
        if (!"REFERENCED".equals(resource.state())
                && !("PUBLISHED".equals(resource.state())
                    && Set.of("managed-agent-instructions", "managed-agent-skills").contains(resource.kind()))) {
            throw conflict(ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                    "A referenced Managed Session resource is missing.");
        }
        verifyStoredResource(resource);
        return new StoredResource(resource.resourceId(), resource.kind(),
                resource.schemaVersion(), resource.byteLength(),
                resource.digest(), resource.bytes());
    }

    HeadRow findHeadForUpdate(String tenantId, String sessionId) {
        // Ordinary writers serialize on their own Session's rows only: the
        // Session root, then the head — the per-Session order retirement
        // also takes behind its tenant guard. Both are locking reads, so
        // neither pins this transaction's REPEATABLE READ snapshot, and
        // requireLive below reads after the waits end. The tenant-wide CAS
        // row stays with explicit publication paths so ordinary writes never
        // queue on it (#13800).
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        return findHeadWithRootLocked(tenantId, sessionId);
    }

    private HeadRow findHeadWithRootLocked(String tenantId, String sessionId) {
        var heads = jdbc.query(
                "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                        + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                headMapper,
                RuntimeAdmissionFences.harnessDrainKey(tenantId),
                RuntimeAdmissionFences.harnessDrainKey(sessionId), tenantId, sessionId);
        ToolPublicationRetentionStore.requireLive(jdbc, tenantId, sessionId);
        return heads.isEmpty() ? null : heads.getFirst();
    }

    HeadRow requireHeadWithRootLocked(String tenantId, String sessionId) {
        HeadRow head = findHeadWithRootLocked(tenantId, sessionId);
        if (head == null) {
            throw sessionNotFound();
        }
        return head;
    }

    HeadRow requireHeartbeatHead(String tenantId, String sessionId) {
        // Preserve the standalone ordinary heartbeat's head-only locking contract.
        return requireHeadWithRootLocked(tenantId, sessionId);
    }

    HeadRow requireHeadForUpdate(String tenantId, String sessionId) {
        HeadRow head = findHeadForUpdate(tenantId, sessionId);
        if (head == null) {
            throw sessionNotFound();
        }
        return head;
    }

    HeadRow requireHead(String tenantId, String sessionId) {
        List<HeadRow> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND"
                            + " tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        headMapper,
                        RuntimeAdmissionFences.harnessDrainKey(tenantId),
                        RuntimeAdmissionFences.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        if (rows.isEmpty()) {
            throw sessionNotFound();
        }
        return rows.get(0);
    }

    TransactionRow findTransactionByCommand(String tenantId,
            String sessionId, String commandKeyHash) {
        List<TransactionRow> rows = jdbc.query(
                "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND command_key_hash = ?",
                transactionMapper, tenantId, sessionId, commandKeyHash);
        return rows.isEmpty() ? null : rows.get(0);
    }

    ResourceRow findResource(String scopeKey, String resourceId) {
        return findResource(scopeKey, resourceId, true);
    }

    ResourceRow findResource(String scopeKey, String resourceId, boolean lock) {
        List<ResourceRow> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key = ? AND session_scope_key = ?"
                        + " AND resource_id = ?" + (lock ? " FOR UPDATE" : ""),
                        resourceMapper,
                        ManagedSessionStore.resourceKey(scopeKey, resourceId),
                        scopeKey,
                        resourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    static TransactionRow transactionRow(ResultSet result)
            throws SQLException {
        return new TransactionRow(result.getString("workspace_id"),
                result.getLong("journal_revision"),
                result.getString("transaction_id"),
                result.getString("operation"),
                result.getString("command_id"),
                result.getString("content_digest"),
                result.getLong("first_sequence"),
                result.getLong("last_sequence"),
                result.getInt("event_count"),
                result.getString("events_digest"),
                result.getString("previous_commit_digest"),
                result.getString("commit_digest"),
                result.getLong("writer_generation"),
                result.getString("writer_id"),
                result.getString("writer_token_hash"),
                result.getLong("activation_epoch"),
                result.getString("latest_checkpoint_resource_id"),
                result.getString("record_encoding"),
                result.getBytes("record_bytes"),
                result.getLong("byte_length"),
                result.getString("record_digest"));
    }

    StoredTransaction storedTransaction(TransactionRow row) {
        if (!"identity".equals(row.recordEncoding())
                || row.recordBytes() == null
                || row.recordBytes().length != row.byteLength()
                || !sha256(row.recordBytes()).equals(row.recordDigest())) {
            throw journalCorrupt();
        }
        return new StoredTransaction(row.journalRevision(),
                row.transactionId(), row.operation(), row.commandId(),
                row.contentDigest(), row.firstSequence(),
                row.lastSequence(), row.eventCount(), row.eventsDigest(),
                row.previousCommitDigest(), row.commitDigest(),
                row.writerGeneration(), row.activationEpoch(),
                row.latestCheckpointResourceId(),
                row.recordEncoding(), Base64.getEncoder()
                        .encodeToString(row.recordBytes()),
                row.byteLength(), row.recordDigest());
    }

    Timestamp databaseNow() {
        Timestamp now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW,
                (row, index) -> ManagedSchemaTime.timestamp(row, 1));
        if (now == null) {
            throw new IllegalStateException("Database time is unavailable");
        }
        return now;
    }

    static long epochMillis(Timestamp timestamp) {
        return timestamp.getTime();
    }

    static long increment(long value, String label) {
        if (value < 0
                || value >= ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw conflict("managed_session_counter_exhausted",
                    "The " + label + " cannot advance.");
        }
        return value + 1;
    }

    static void validateScope(String tenantId, String workspaceId,
            String sessionId) {
        validateText(tenantId, "tenantId", 128);
        validateKeyComponent(workspaceId, "workspaceId");
        validateKeyComponent(sessionId, "sessionId");
    }

    static void validateKeyComponent(String value, String label) {
        validateStableId(value, label);
        if (value.contains("/") || value.contains("\\")
                || value.chars().allMatch(character -> character == '.')) {
            throw invalid(label + " is not a safe key component.");
        }
    }

    static void validateStableId(String value, String label) {
        validateText(value, label, MAX_ID_BYTES);
    }

    static void validateText(String value, String label,
            int maxBytes) {
        if (!isValidText(value, maxBytes)) {
            throw invalid(label + " is invalid.");
        }
    }

    static boolean isValidText(String value, int maxBytes) {
        if (value == null || value.isEmpty() || value.chars().anyMatch(character -> character < 32 || character == 127)) {
            return false;
        }
        try {
            return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(value).length <= maxBytes;
        } catch (IllegalArgumentException invalidUnicode) {
            return false;
        }
    }

    static void validateDigest(String value, String label,
            boolean nullable) {
        if (value == null && nullable) {
            return;
        }
        if (value == null || !DIGEST.matcher(value).matches()) {
            throw invalid(label + " must be a lowercase SHA-256 digest.");
        }
    }

    static byte[] decodeBase64(String value, int maxBytes,
            String label) {
        if (value == null) {
            throw invalid(label + " is required.");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(value);
        } catch (IllegalArgumentException error) {
            throw invalid(label + " is not valid Base64.");
        }
        if (decoded.length > maxBytes) {
            throw payloadTooLarge(label + " exceeds its byte limit.");
        }
        return decoded;
    }

    void verifyStoredResource(ResourceRow resource) {
        if (resource.deletionOperation() != null
                || resource.captureState() != null && !"VERIFIED".equals(resource.captureState())
                || resource.resourceId().startsWith("capture-segment-")
                || resource.resourceId().startsWith("capture-seal-")) {
            throw resourceCorrupt();
        }
        if ("TOOL_PUBLICATION".equals(resource.storageKind())) {
            if (!"REFERENCED".equals(resource.state()) || resource.bytes() != null
                    || resource.objectKey() == null || resource.objectVersionId() != null
                    || resource.encryptionKeyId() != null
                    || !"managed-tool-outcome".equals(resource.kind())
                    || resource.byteLength() > 2L * 1024 * 1024) {
                throw resourceCorrupt();
            }
            Long matching =
                    jdbc.queryForObject(
                            "SELECT COUNT(*) FROM ma_output_capture p JOIN ma_resource o ON"
                                + " o.scope_key = p.scope_key AND o.publication_id ="
                                + " p.publication_id WHERE p.tenant_id = ? AND p.workspace_id = ?"
                                + " AND p.session_id = ? AND p.admission_resource_id = ? AND"
                                + " p.producer_phase IN ('FINISHED', 'REFERENCED') AND"
                                + " p.is_quarantined = FALSE AND o.slot_key = X'61646d697373696f6e'"
                                + " AND o.capture_state = 'VERIFIED' AND o.resource_id = ? AND"
                                + " o.capture_object_key = ? AND o.sha256 = ? AND o.byte_length ="
                                + " ?",
                            Long.class,
                            resource.tenantId(),
                            resource.workspaceId(),
                            resource.sessionId(),
                            resource.resourceId(),
                            resource.resourceId(),
                            resource.objectKey(),
                            resource.digest(),
                            resource.byteLength());
            if (matching == null || matching != 1) {
                throw resourceCorrupt();
            }
            return;
        }
        if ("OSS_OBJECT".equals(resource.storageKind())) {
            if (!("PUBLISHED".equals(resource.state()) || "REFERENCED".equals(resource.state()))
                    || resource.bytes() != null || resource.objectKey() == null
                    || resource.objectVersionId() != null || resource.encryptionKeyId() != null
                    || resource.captureState() != null) {
                throw resourceCorrupt();
            }
            return;
        }
        if (!"MYSQL_INLINE".equals(resource.storageKind())
                || !("REFERENCED".equals(resource.state())
                    || "PUBLISHED".equals(resource.state()) && resource.schemaVersion() == 1
                        && (resource.byteLength() > 0 && resource.byteLength() <= toolResultLimit(resource.kind())
                            || "managed-agent-instructions".equals(resource.kind())
                                && resource.byteLength() >= 0
                                && resource.byteLength() <= ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES
                            || "managed-agent-skills".equals(resource.kind())
                                && resource.byteLength() > 0
                                && resource.byteLength() <= ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES))
                || resource.bytes() == null
                || resource.objectKey() != null
                || resource.objectVersionId() != null
                || resource.encryptionKeyId() != null
                || resource.bytes().length != resource.byteLength()
                || !sha256(resource.bytes()).equals(resource.digest())) {
            throw resourceCorrupt();
        }
        if ("managed-tool-outcome".equals(resource.kind())) {
            Long quarantined = jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?"
                            + " AND admission_resource_id = ? AND is_quarantined = TRUE",
                    Long.class, resource.tenantId(), resource.workspaceId(),
                    resource.sessionId(), resource.resourceId());
            if (quarantined != null && quarantined > 0) {
                throw resourceCorrupt();
            }
        }
    }

    static ManagedAgentException resourceCorrupt() {
        return new ManagedAgentException(500,
                "managed_session_resource_corrupt",
                "The Managed Session resource failed verification.");
    }

    static void validateCounter(long value, String label,
            long minimum) {
        if (value < minimum
                || value > ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw invalid(label + " is outside its safe integer bound.");
        }
    }

    static void validateUtf8JsonLines(byte[] bytes,
            int expectedRecords) {
        try {
            StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
        } catch (CharacterCodingException error) {
            throw invalid("recordBytesBase64 is not valid UTF-8.");
        }
        int records = 0;
        int lineLength = 0;
        for (byte value : bytes) {
            if (value == '\n') {
                if (lineLength == 0) {
                    throw invalid("recordBytesBase64 contains a blank line.");
                }
                if (lineLength > ManagedSessionStoreModels.MAX_EVENT_BYTES) {
                    throw payloadTooLarge("A Managed Session record exceeds"
                            + " its byte limit.");
                }
                records++;
                lineLength = 0;
            } else {
                lineLength++;
            }
        }
        if (lineLength != 0 || records != expectedRecords) {
            throw invalid("recordBytesBase64 must end with a newline and"
                    + " match recordCount.");
        }
    }

    void requireHeadScope(HeadRow head, String tenantId,
            String workspaceId, String sessionId) {
        if (!tenantId.equals(head.tenantId())
                || !workspaceId.equals(head.workspaceId())
                || !sessionId.equals(head.sessionId())) {
            throw sessionNotFound();
        }
        if (head.storageVersion() < 1 || head.storageVersion() > com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedStorageVersions.SUPPORTED) {
            throw conflict("managed_session_storage_version_unsupported",
                    "The Managed Session storage version is unsupported.");
        }
        readerVersion.requireReadable(head.storageVersion());
        if (!HEAD_STATES.contains(head.state())
                || !RECOVERY_STATES.contains(head.recoveryStatus())
                || head.writerGeneration() < 1
                || head.writerGeneration()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.journalRevision() < 0
                || head.journalRevision()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.committedSequence() < 0
                || head.committedSequence()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.activationEpoch() < 0
                || head.activationEpoch()
                        > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || head.compactedThroughRevision() < 0
                || head.compactedThroughRevision()
                        > head.journalRevision()
                || head.lastCommitDigest() != null
                        && !DIGEST.matcher(head.lastCommitDigest()).matches()
                || head.latestCheckpointResourceId() != null
                        && !isValidText(head.latestCheckpointResourceId(),
                                MAX_ID_BYTES)
                || ("ACTIVE".equals(head.state())
                        || "SEALED".equals(head.state()))
                        && (!isValidText(head.writerId(), MAX_ID_BYTES)
                                || head.writerLeaseUntil() == null
                                || head.leaseTokenHash() == null
                                || !DIGEST.matcher(head.leaseTokenHash())
                                        .matches())) {
            throw headCorrupt();
        }
    }

    static void requireResourceScope(ResourceRow resource,
            String tenantId, String workspaceId, String sessionId,
            String resourceId) {
        if (!tenantId.equals(resource.tenantId())
                || !workspaceId.equals(resource.workspaceId())
                || !sessionId.equals(resource.sessionId())
                || !resourceId.equals(resource.resourceId())) {
            throw sessionNotFound();
        }
    }

    static void requireTransactionWorkspace(TransactionRow row,
            String workspaceId) {
        if (!workspaceId.equals(row.workspaceId())) {
            throw new ManagedAgentException(500,
                    ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                    "The Managed Session transaction scope is corrupt.");
        }
    }

    void ensureSessionRoot(String tenantId, String sessionId) {
        // Take the root row exclusively first: ordinary writers lock it
        // without a tenant guard (#13800); keep that order before
        // initializing the session event stream.
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        long now = epochMillis(databaseNow());
        jdbc.update(
                "INSERT IGNORE INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id,"
                        + " gmt_modified) VALUES (?, ?, 'SESSION', X'', ?)",
                tenantId,
                sessionId,
                now);
    }

    static String commandKeyHash(String operation,
            String commandId) {
        return sha256((operation + "\u0000" + commandId)
                .getBytes(StandardCharsets.UTF_8));
    }

    static String sha256(byte[] value) {
        return DigestUtils.sha256Hex(value);
    }

    static ManagedAgentException sessionNotFound() {
        return new ManagedAgentException(404,
                "managed_session_not_found",
                "The Managed Session does not exist.");
    }

    // Package-private: ToolPublicationStore's evidence reads answer a
    // damaged journal with the same fault the session store raises.
    static ManagedAgentException journalCorrupt() {
        return new ManagedAgentException(500,
                ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                "The Managed Session transaction failed verification.");
    }

    static ManagedAgentException headCorrupt() {
        return new ManagedAgentException(500,
                ManagedSessionStoreModels.ERROR_HEAD_CORRUPT,
                "The Managed Session head failed verification.");
    }

    static ManagedAgentException invalid(String message) {
        return new ManagedAgentException(400,
                ManagedSessionStoreModels.ERROR_INVALID_REQUEST, message);
    }

    static ManagedAgentException payloadTooLarge(String message) {
        return new ManagedAgentException(413,
                ManagedSessionStoreModels.ERROR_PAYLOAD_TOO_LARGE, message);
    }

    static ManagedAgentException conflict(String code, String message) {
        return new ManagedAgentException(409, code, message);
    }

    record HeadRow(String tenantId, String workspaceId,
            String sessionId, String state, int storageVersion,
            long writerGeneration, String writerId,
            Timestamp writerLeaseUntil, String leaseTokenHash,
            long journalRevision, long committedSequence,
            String lastCommitDigest, long activationEpoch,
            String latestCheckpointResourceId,
            long compactedThroughRevision, long packedThroughRevision, String recoveryStatus,
            String recoveryDetailCode, String activationId,
            String activationPhase, Long activationEventEpoch,
            Long activationExpiresAt, Long activationHeadRevision) {
    }

    record TransactionRow(String workspaceId, long journalRevision,
            String transactionId, String operation, String commandId,
            String contentDigest, long firstSequence, long lastSequence,
            int eventCount, String eventsDigest,
            String previousCommitDigest, String commitDigest,
            long writerGeneration, String writerId, String writerTokenHash,
            long activationEpoch, String latestCheckpointResourceId,
            String recordEncoding, byte[] recordBytes, long byteLength,
            String recordDigest) {
    }

    TransactionRow withRecordBytes(TransactionRow row, byte[] bytes) {
        return new TransactionRow(row.workspaceId(), row.journalRevision(), row.transactionId(),
                row.operation(), row.commandId(), row.contentDigest(), row.firstSequence(),
                row.lastSequence(), row.eventCount(), row.eventsDigest(),
                row.previousCommitDigest(), row.commitDigest(), row.writerGeneration(),
                row.writerId(), row.writerTokenHash(), row.activationEpoch(),
                row.latestCheckpointResourceId(), row.recordEncoding(), bytes, row.byteLength(),
                row.recordDigest());
    }

    record ResourceRow(String tenantId, String workspaceId,
            String sessionId, String resourceId, String kind,
            int schemaVersion, long byteLength, String digest,
            String storageKind, byte[] bytes, String objectKey,
            String objectVersionId, String encryptionKeyId, String state, String captureState, String deletionOperation) {
    }

    /**
     * Converts the last activation.changed payload of a committed transaction, so the head row can
     * answer authorization reads without rescanning the journal. The payload was already parsed by
     * the extension record pass of this commit.
     */
    static ActivationChange activationChange(JsonNode payload) {
        if (payload == null) {
            return null;
        }
        return new ActivationChange(
                ToolPublicationContract.text(payload, "activationId"),
                ToolPublicationContract.text(payload, "phase"),
                payload.path("epoch").asLong(),
                ManagedExtensionRecords.millisLenient(
                        payload.path("expiresAt")));
    }

    record ActivationChange(String id, String phase, long epoch,
            Long expiresAt) {
    }
}
