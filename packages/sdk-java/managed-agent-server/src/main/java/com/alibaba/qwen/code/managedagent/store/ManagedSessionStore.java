package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class ManagedSessionStore {
    private static final int STORAGE_VERSION = 1;
    private static final int MAX_ID_BYTES = 512;
    private static final int MAX_TEXT_BYTES = 4096;
    private static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern WRITER_TOKEN = Pattern.compile(
            "^[A-Za-z0-9_-]{"
                    + ManagedSessionStoreModels.MIN_WRITER_TOKEN_LENGTH + ","
                    + ManagedSessionStoreModels.MAX_WRITER_TOKEN_LENGTH + "}$");
    private static final Set<String> HEAD_STATES = Set.of(
            "ACTIVE", "SEALED", "DELETING", "DELETED");
    private static final Set<String> RECOVERY_STATES = Set.of(
            "READY", "BLOCKED_RESOURCE", "BLOCKED_WORKSPACE",
            "BLOCKED_EXECUTION");
    private final JdbcTemplate jdbc;
    private final RowMapper<HeadRow> headMapper = (result, row) ->
            new HeadRow(result.getString("tenant_id"),
                    result.getString("workspace_id"),
                    result.getString("session_id"),
                    result.getString("state"),
                    result.getInt("storage_version"),
                    result.getLong("writer_generation"),
                    result.getString("writer_id"),
                    result.getTimestamp("writer_lease_until"),
                    result.getString("lease_token_hash"),
                    result.getLong("journal_revision"),
                    result.getLong("committed_sequence"),
                    result.getString("last_commit_digest"),
                    result.getLong("activation_epoch"),
                    result.getString("latest_checkpoint_resource_id"),
                    result.getLong("compacted_through_revision"),
                    result.getString("recovery_status"),
                    result.getString("recovery_detail_code"));
    private final RowMapper<TransactionRow> transactionMapper =
            (result, row) -> transactionRow(result);
    private final RowMapper<ResourceRow> resourceMapper = (result, row) ->
            new ResourceRow(result.getString("tenant_id"),
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
                    result.getString("state"));

    public ManagedSessionStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        validateStableId(request.writerId(), "writerId");
        validateLeaseMillis(request.leaseMillis());
        String tokenHash = tokenHash(writerToken);
        Timestamp createdAt = databaseNow();
        Timestamp initialLeaseUntil = plusMillis(createdAt,
                request.leaseMillis());
        try {
            jdbc.update("INSERT INTO qwen_managed_session_journal_head"
                            + " (tenant_id, workspace_id, session_id,"
                            + " storage_version, state, writer_generation,"
                            + " writer_id, writer_lease_until,"
                            + " lease_token_hash, journal_revision,"
                            + " committed_sequence, activation_epoch,"
                            + " compacted_through_revision, recovery_status,"
                            + " created_at, updated_at) VALUES (?, ?, ?, ?,"
                            + " 'ACTIVE', 1, ?, ?, ?, 0, 0, 0, 0, 'READY',"
                            + " ?, ?)",
                    tenantId, request.workspaceId(), sessionId,
                    STORAGE_VERSION, request.writerId(), initialLeaseUntil,
                    tokenHash, createdAt, createdAt);
            return new WriterGrant(1, initialLeaseUntil.getTime(), 0, 0,
                    null, 0, false);
        } catch (DuplicateKeyException ignored) {
            // A prior acquire created the row; lock and inspect it below.
        }
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if ("DELETING".equals(head.state())
                || "DELETED".equals(head.state())) {
            throw conflict("managed_session_not_writable",
                    "The Managed Session does not accept a writer.");
        }
        if (!"ACTIVE".equals(head.state())
                && !"SEALED".equals(head.state())) {
            throw conflict("managed_session_not_writable",
                    "The Managed Session state is not writable.");
        }
        Timestamp now = databaseNow();
        if ("ACTIVE".equals(head.state())
                && head.writerLeaseUntil() != null
                && head.writerLeaseUntil().after(now)) {
            if (!request.writerId().equals(head.writerId())
                    || !secureEquals(tokenHash, head.leaseTokenHash())) {
                throw writerConflict();
            }
            Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                    plusMillis(now, request.leaseMillis()));
            jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                            + " writer_lease_until = ?, updated_at = ?"
                            + " WHERE tenant_id = ? AND session_id = ?",
                    leaseUntil, now, tenantId, sessionId);
            return grant(head, leaseUntil, true);
        }
        long generation = increment(head.writerGeneration(),
                "writer generation");
        Timestamp leaseUntil = plusMillis(now, request.leaseMillis());
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " state = 'ACTIVE', writer_generation = ?,"
                        + " writer_id = ?, writer_lease_until = ?,"
                        + " lease_token_hash = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                generation, request.writerId(), leaseUntil, tokenHash, now,
                tenantId, sessionId);
        return new WriterGrant(generation, leaseUntil.getTime(),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), false);
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateLeaseMillis(request.leaseMillis());
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                plusMillis(now, request.leaseMillis()));
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " writer_lease_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                leaseUntil, now, tenantId, sessionId);
        return grant(head, leaseUntil, false);
    }

    @Transactional
    public SealReceipt sealWriter(String tenantId, String sessionId,
            String writerToken, SealWriterRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        validateStableId(request.writerId(), "writerId");
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if ("SEALED".equals(head.state())
                && request.writerGeneration() == head.writerGeneration()
                && request.writerId().equals(head.writerId())
                && secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())) {
            return new SealReceipt(head.writerGeneration(), "SEALED", true);
        }
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, false);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " state = 'SEALED', updated_at = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                now, tenantId, sessionId);
        return new SealReceipt(head.writerGeneration(), "SEALED", false);
    }

    @Transactional
    public CommitReceipt commit(String tenantId, String sessionId,
            String writerToken, CommitTransactionRequest request) {
        validateScope(tenantId, request.workspaceId(), sessionId);
        validateStableId(request.writerId(), "writerId");
        ValidatedCommit validated = validateCommit(request);
        HeadRow head = requireHeadForUpdate(tenantId, sessionId);
        requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        TransactionRow existing = findTransactionByCommand(tenantId,
                sessionId, commandKeyHash(request.operation(),
                        request.commandId()));
        if (existing != null) {
            requireTransactionWorkspace(existing, request.workspaceId());
            return replay(existing, request, validated.recordDigest(),
                    writerToken);
        }
        Timestamp now = databaseNow();
        requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        validateHead(head, request);
        long revision = increment(head.journalRevision(),
                "journal revision");
        String scopeKey = sessionScopeKey(tenantId, sessionId);
        commitResources(scopeKey, tenantId, sessionId, request, revision,
                now, validated.resources());
        jdbc.update("INSERT INTO qwen_managed_session_journal_tx"
                        + " (tenant_id, workspace_id, session_id,"
                        + " journal_revision, command_key_hash,"
                        + " transaction_id, operation, command_id,"
                        + " content_digest, first_sequence, last_sequence,"
                        + " event_count, events_digest,"
                        + " previous_commit_digest, commit_digest,"
                        + " writer_generation, writer_id,"
                        + " writer_token_hash, activation_epoch,"
                        + " latest_checkpoint_resource_id,"
                        + " record_encoding, record_bytes, byte_length,"
                        + " record_digest, created_at) VALUES (?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?,"
                        + " 'identity', ?, ?, ?, ?)",
                tenantId, request.workspaceId(), sessionId, revision,
                commandKeyHash(request.operation(), request.commandId()),
                request.transactionId(), request.operation(),
                request.commandId(), request.contentDigest(),
                request.firstSequence(), request.lastSequence(),
                request.eventCount(), request.eventsDigest(),
                request.previousCommitDigest(), request.commitDigest(),
                request.writerGeneration(), request.writerId(),
                tokenHash(writerToken), request.activationEpoch(),
                request.latestCheckpointResourceId(),
                validated.recordBytes(), validated.recordBytes().length,
                validated.recordDigest(), now);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " journal_revision = ?, committed_sequence = ?,"
                        + " last_commit_digest = ?, activation_epoch = ?,"
                        + " latest_checkpoint_resource_id = COALESCE(?,"
                        + " latest_checkpoint_resource_id),"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND session_id = ?",
                revision, request.lastSequence(), request.commitDigest(),
                request.activationEpoch(),
                request.latestCheckpointResourceId(), now, tenantId,
                sessionId);
        return new CommitReceipt(revision, request.transactionId(),
                request.commandId(), request.operation(),
                request.firstSequence(), request.lastSequence(),
                request.lastSequence(), request.commitDigest(), false);
    }

    @Transactional(readOnly = true)
    public RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        validateScope(tenantId, workspaceId, sessionId);
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        return new RestoreHead(head.state(), head.storageVersion(),
                head.writerGeneration(), head.journalRevision(),
                head.committedSequence(), head.lastCommitDigest(),
                head.activationEpoch(), head.latestCheckpointResourceId(),
                head.compactedThroughRevision(), head.recoveryStatus(),
                head.recoveryDetailCode());
    }

    @Transactional(readOnly = true)
    public TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit) {
        validateScope(tenantId, workspaceId, sessionId);
        if (afterRevision < 0
                || afterRevision > ManagedSessionStoreModels.MAX_SAFE_COUNTER
                || limit < 1 || limit > 100) {
            throw invalid("afterRevision and limit are outside their bounds.");
        }
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        List<TransactionSize> candidates = jdbc.query(
                "SELECT journal_revision, byte_length"
                        + " FROM qwen_managed_session_journal_tx"
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
                throw journalCorrupt();
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
            throw journalCorrupt();
        }
        List<TransactionRow> rows = selectedCount == 0 ? List.of()
                : jdbc.query(
                        "SELECT *"
                                + " FROM qwen_managed_session_journal_tx"
                                + " WHERE tenant_id = ? AND session_id = ?"
                                + " AND journal_revision > ?"
                                + " ORDER BY journal_revision LIMIT ?",
                        transactionMapper, tenantId, sessionId,
                        afterRevision, selectedCount);
        if (rows.size() != selectedCount) {
            throw journalCorrupt();
        }
        for (int index = 0; index < rows.size(); index++) {
            TransactionRow row = rows.get(index);
            TransactionSize candidate = candidates.get(index);
            if (row.journalRevision() != candidate.journalRevision()
                    || row.byteLength() != candidate.byteLength()) {
                throw journalCorrupt();
            }
        }
        boolean hasMore = candidates.size() > selectedCount;
        rows.forEach(row -> requireTransactionWorkspace(row, workspaceId));
        List<StoredTransaction> transactions = rows.stream()
                .map(this::storedTransaction).toList();
        long nextRevision = transactions.isEmpty() ? afterRevision
                : transactions.get(transactions.size() - 1)
                        .journalRevision();
        return new TransactionPage(transactions, nextRevision, hasMore);
    }

    @Transactional
    public StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken) {
        validateScope(tenantId, workspaceId, sessionId);
        validateStableId(resourceId, "resourceId");
        HeadRow head = requireHead(tenantId, sessionId);
        requireHeadScope(head, tenantId, workspaceId, sessionId);
        requireReadGrant(head, writerToken);
        String scopeKey = sessionScopeKey(tenantId, sessionId);
        ResourceRow resource = findResource(scopeKey, resourceId);
        if (resource == null) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    ManagedSessionStoreModels.ERROR_RESOURCE_NOT_FOUND,
                    "The Managed Session resource does not exist.");
        }
        requireResourceScope(resource, tenantId, workspaceId, sessionId,
                resourceId);
        verifyStoredResource(resource);
        jdbc.update("UPDATE qwen_managed_session_resource SET"
                        + " last_verified_at = ? WHERE session_scope_key = ?"
                        + " AND resource_id = ?",
                databaseNow(), scopeKey, resourceId);
        return new StoredResource(resource.resourceId(), resource.kind(),
                resource.schemaVersion(), resource.byteLength(),
                resource.digest(), resource.bytes());
    }

    private void commitResources(String scopeKey, String tenantId,
            String sessionId, CommitTransactionRequest request,
            long revision, Timestamp now,
            List<ValidatedResource> resources) {
        Set<String> resourceIds = new HashSet<>();
        for (ValidatedResource input : resources) {
            CommitResource resource = input.resource();
            if (!resourceIds.add(resource.resourceId())) {
                throw invalid("resources contains a duplicate resourceId.");
            }
            ResourceRow existing = findResource(scopeKey,
                    resource.resourceId());
            if (existing == null) {
                if (input.bytes() == null) {
                    throw conflict(
                            ManagedSessionStoreModels.ERROR_RESOURCE_MISSING,
                            "A referenced Managed Session resource is"
                                    + " missing.");
                }
                jdbc.update("INSERT INTO qwen_managed_session_resource"
                                + " (session_scope_key, tenant_id,"
                                + " workspace_id, session_id, resource_id,"
                                + " kind, schema_version, byte_length, sha256,"
                                + " storage_kind, inline_bytes,"
                                + " publish_command_id, state, created_at,"
                                + " last_verified_at) VALUES (?, ?, ?, ?, ?,"
                                + " ?, ?, ?, ?, 'MYSQL_INLINE', ?, ?,"
                                + " 'REFERENCED', ?, ?)",
                        scopeKey, tenantId, request.workspaceId(), sessionId,
                        resource.resourceId(), resource.kind(),
                        resource.schemaVersion(), resource.byteLength(),
                        resource.digest(), input.bytes(), request.commandId(),
                        now, now);
            } else {
                requireResourceScope(existing, tenantId,
                        request.workspaceId(), sessionId,
                        resource.resourceId());
                verifyStoredResource(existing);
                if (!resource.kind().equals(existing.kind())
                        || resource.schemaVersion()
                                != existing.schemaVersion()
                        || resource.byteLength() != existing.byteLength()
                        || !resource.digest().equals(existing.digest())) {
                    throw conflict("managed_session_resource_conflict",
                            "A resourceId was reused with different"
                                    + " content metadata.");
                }
            }
            jdbc.update("INSERT INTO qwen_managed_session_resource_ref"
                            + " (session_scope_key, tenant_id, workspace_id,"
                            + " session_id, journal_revision, resource_id,"
                            + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    scopeKey, tenantId, request.workspaceId(), sessionId,
                    revision, resource.resourceId(), now);
        }
    }

    private ValidatedCommit validateCommit(
            CommitTransactionRequest request) {
        validateStableId(request.transactionId(), "transactionId");
        validateText(request.operation(), "operation", MAX_TEXT_BYTES);
        validateStableId(request.commandId(), "commandId");
        validateDigest(request.contentDigest(), "contentDigest", false);
        validateDigest(request.eventsDigest(), "eventsDigest", true);
        validateDigest(request.previousCommitDigest(),
                "previousCommitDigest", true);
        validateDigest(request.commitDigest(), "commitDigest", true);
        validateDigest(request.recordDigest(), "recordDigest", false);
        validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateCounter(request.expectedJournalRevision(),
                "expectedJournalRevision", 0);
        validateCounter(request.expectedCommittedSequence(),
                "expectedCommittedSequence", 0);
        validateCounter(request.firstSequence(), "firstSequence", 0);
        validateCounter(request.lastSequence(), "lastSequence", 0);
        validateCounter(request.activationEpoch(), "activationEpoch", 0);
        if (request.latestCheckpointResourceId() != null) {
            validateStableId(request.latestCheckpointResourceId(),
                    "latestCheckpointResourceId");
        }
        if (request.eventCount() < 0
                || request.eventCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                || request.recordCount() < 1
                || request.recordCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                                + 1) {
            throw invalid("eventCount or recordCount is outside its bound.");
        }
        byte[] recordBytes = decodeBase64(request.recordBytesBase64(),
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES,
                "recordBytesBase64");
        if (!sha256(recordBytes).equals(request.recordDigest())) {
            throw invalid("recordDigest does not match recordBytesBase64.");
        }
        validateUtf8JsonLines(recordBytes, request.recordCount());
        if ("session.create".equals(request.operation())) {
            if (request.eventCount() != 0 || request.firstSequence() != 0
                    || request.lastSequence() != 0
                    || request.recordCount() != 2
                    || request.eventsDigest() != null
                    || request.previousCommitDigest() != null
                    || request.commitDigest() != null
                    || request.latestCheckpointResourceId() != null) {
                throw invalid("The session.create transaction must use"
                        + " sequence zero and no commit digest chain.");
            }
        } else {
            if (request.eventCount() < 1
                    || request.firstSequence() < 1
                    || request.lastSequence() < request.firstSequence()
                    || request.lastSequence() - request.firstSequence() + 1
                            != request.eventCount()
                    || request.eventsDigest() == null
                    || request.commitDigest() == null
                    || request.recordCount() != request.eventCount() + 1) {
                throw invalid("The transaction event range or record count"
                        + " is invalid.");
            }
        }
        List<ValidatedResource> resources = new ArrayList<>();
        long inlineBytes = 0;
        List<CommitResource> requestedResources = request.resources() == null
                ? List.of() : request.resources();
        if (requestedResources.size()
                > ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION) {
            throw invalid("resources exceeds its item limit.");
        }
        for (CommitResource resource : requestedResources) {
            if (resource == null) {
                throw invalid("resources must not contain null entries.");
            }
            validateStableId(resource.resourceId(), "resourceId");
            validateStableId(resource.kind(), "resource kind");
            validateDigest(resource.digest(), "resource digest", false);
            if (resource.schemaVersion() < 1 || resource.byteLength() < 0) {
                throw invalid("Resource version or length is invalid.");
            }
            if (resource.byteLength()
                    > ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES) {
                throw new ApiException(HttpStatus.NOT_IMPLEMENTED,
                        ManagedSessionStoreModels.ERROR_OSS_DISABLED,
                        "Resources larger than 64 KiB require the disabled"
                                + " OSS storage path.");
            }
            byte[] bytes = resource.bytesBase64() == null ? null
                    : decodeBase64(resource.bytesBase64(),
                            ManagedSessionStoreModels
                                    .MAX_INLINE_RESOURCE_BYTES,
                            "resource bytesBase64");
            if (bytes != null && (bytes.length != resource.byteLength()
                    || !sha256(bytes).equals(resource.digest()))) {
                throw invalid("Resource bytes do not match their length or"
                        + " digest.");
            }
            if (bytes != null) {
                inlineBytes += bytes.length;
                if (inlineBytes
                        > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES) {
                    throw payloadTooLarge("Inline resources exceed their"
                            + " transaction byte limit.");
                }
            }
            resources.add(new ValidatedResource(resource, bytes));
        }
        if (request.latestCheckpointResourceId() != null
                && resources.stream().map(ValidatedResource::resource)
                        .noneMatch(resource -> request
                                .latestCheckpointResourceId()
                                .equals(resource.resourceId())
                                && "managed-checkpoint"
                                        .equals(resource.kind()))) {
            throw invalid("latestCheckpointResourceId must identify a"
                    + " managed-checkpoint resource in this transaction.");
        }
        return new ValidatedCommit(recordBytes, request.recordDigest(),
                resources);
    }

    private void validateHead(HeadRow head,
            CommitTransactionRequest request) {
        if (request.expectedJournalRevision() != head.journalRevision()
                || request.expectedCommittedSequence()
                        != head.committedSequence()
                || !Objects.equals(request.previousCommitDigest(),
                        head.lastCommitDigest())) {
            throw conflict("managed_session_head_conflict",
                    "The Managed Session head changed; reload before"
                            + " retrying.");
        }
        if (request.activationEpoch() < head.activationEpoch()) {
            throw conflict("managed_session_activation_conflict",
                    "The activation epoch is stale.");
        }
        if (!"READY".equals(head.recoveryStatus())) {
            throw conflict("managed_session_recovery_blocked",
                    "The Managed Session is blocked from new commits.");
        }
        if ("session.create".equals(request.operation())) {
            if (head.journalRevision() != 0
                    || head.committedSequence() != 0) {
                throw conflict("managed_session_head_conflict",
                        "The Managed Session genesis is already committed.");
            }
        } else if (head.journalRevision() == 0
                || request.firstSequence()
                        != increment(head.committedSequence(),
                                "committed sequence")) {
            throw conflict("managed_session_head_conflict",
                    "The transaction does not extend the committed"
                            + " sequence.");
        }
    }

    private CommitReceipt replay(TransactionRow existing,
            CommitTransactionRequest request, String recordDigest,
            String writerToken) {
        if (!existing.operation().equals(request.operation())
                || !existing.commandId().equals(request.commandId())
                || !existing.transactionId()
                        .equals(request.transactionId())
                || !existing.contentDigest().equals(request.contentDigest())
                || !existing.recordDigest().equals(recordDigest)
                || existing.firstSequence() != request.firstSequence()
                || existing.lastSequence() != request.lastSequence()
                || existing.eventCount() != request.eventCount()
                || !Objects.equals(existing.eventsDigest(),
                        request.eventsDigest())
                || !Objects.equals(existing.previousCommitDigest(),
                        request.previousCommitDigest())
                || existing.writerGeneration()
                        != request.writerGeneration()
                || !existing.writerId().equals(request.writerId())
                || !secureEquals(existing.writerTokenHash(),
                        tokenHash(writerToken))
                || existing.activationEpoch() != request.activationEpoch()
                || !Objects.equals(existing.latestCheckpointResourceId(),
                        request.latestCheckpointResourceId())
                || !Objects.equals(existing.commitDigest(),
                        request.commitDigest())) {
            throw conflict(
                    ManagedSessionStoreModels.ERROR_IDEMPOTENCY_CONFLICT,
                    "The command key was reused with different content.");
        }
        return new CommitReceipt(existing.journalRevision(),
                existing.transactionId(), existing.commandId(),
                existing.operation(), existing.firstSequence(),
                existing.lastSequence(), existing.lastSequence(),
                existing.commitDigest(), true);
    }

    private void requireWriter(HeadRow head, String writerId,
            long writerGeneration, String writerToken, Timestamp now,
            boolean requireUnexpired) {
        if (!"ACTIVE".equals(head.state())
                || writerGeneration != head.writerGeneration()
                || !writerId.equals(head.writerId())
                || !secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())
                || requireUnexpired && (head.writerLeaseUntil() == null
                        || !head.writerLeaseUntil().after(now))) {
            throw writerConflict();
        }
    }

    private void requireReadGrant(HeadRow head, String writerToken) {
        Timestamp now = databaseNow();
        if (!"ACTIVE".equals(head.state())
                || !secureEquals(tokenHash(writerToken),
                        head.leaseTokenHash())
                || head.writerLeaseUntil() == null
                || !head.writerLeaseUntil().after(now)) {
            throw writerConflict();
        }
    }

    private HeadRow findHeadForUpdate(String tenantId, String sessionId) {
        List<HeadRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_session_journal_head"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " FOR UPDATE",
                headMapper, tenantId, sessionId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private HeadRow requireHeadForUpdate(String tenantId, String sessionId) {
        HeadRow head = findHeadForUpdate(tenantId, sessionId);
        if (head == null) {
            throw sessionNotFound();
        }
        return head;
    }

    private HeadRow requireHead(String tenantId, String sessionId) {
        List<HeadRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_session_journal_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                headMapper, tenantId, sessionId);
        if (rows.isEmpty()) {
            throw sessionNotFound();
        }
        return rows.get(0);
    }

    private TransactionRow findTransactionByCommand(String tenantId,
            String sessionId, String commandKeyHash) {
        List<TransactionRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND command_key_hash = ?",
                transactionMapper, tenantId, sessionId, commandKeyHash);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private ResourceRow findResource(String scopeKey, String resourceId) {
        List<ResourceRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_session_resource"
                        + " WHERE session_scope_key = ? AND resource_id = ?",
                resourceMapper, scopeKey, resourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static TransactionRow transactionRow(ResultSet result)
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

    private StoredTransaction storedTransaction(TransactionRow row) {
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

    private Timestamp databaseNow() {
        Timestamp now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP",
                Timestamp.class);
        if (now == null) {
            throw new IllegalStateException("Database time is unavailable");
        }
        return now;
    }

    private static WriterGrant grant(HeadRow head, Timestamp leaseUntil,
            boolean replayed) {
        return new WriterGrant(head.writerGeneration(), leaseUntil.getTime(),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), replayed);
    }

    private static Timestamp plusMillis(Timestamp timestamp, long millis) {
        return Timestamp.from(timestamp.toInstant().plusMillis(millis));
    }

    private static Timestamp laterOf(Timestamp left, Timestamp right) {
        return left != null && left.after(right) ? left : right;
    }

    private static long increment(long value, String label) {
        if (value < 0
                || value >= ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw conflict("managed_session_counter_exhausted",
                    "The " + label + " cannot advance.");
        }
        return value + 1;
    }

    private static void validateScope(String tenantId, String workspaceId,
            String sessionId) {
        validateText(tenantId, "tenantId", 128);
        validateKeyComponent(workspaceId, "workspaceId");
        validateKeyComponent(sessionId, "sessionId");
    }

    private static void validateKeyComponent(String value, String label) {
        validateStableId(value, label);
        if (value.contains("/") || value.contains("\\")
                || value.chars().allMatch(character -> character == '.')) {
            throw invalid(label + " is not a safe key component.");
        }
    }

    private static void validateStableId(String value, String label) {
        validateText(value, label, MAX_ID_BYTES);
    }

    private static void validateText(String value, String label,
            int maxBytes) {
        if (!isValidText(value, maxBytes)) {
            throw invalid(label + " is invalid.");
        }
    }

    private static boolean isValidText(String value, int maxBytes) {
        return value != null && !value.isEmpty()
                && value.getBytes(StandardCharsets.UTF_8).length <= maxBytes
                && value.chars().noneMatch(character -> character < 32
                        || character == 127);
    }

    private static void validateDigest(String value, String label,
            boolean nullable) {
        if (value == null && nullable) {
            return;
        }
        if (value == null || !DIGEST.matcher(value).matches()) {
            throw invalid(label + " must be a lowercase SHA-256 digest.");
        }
    }

    private static byte[] decodeBase64(String value, int maxBytes,
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

    private static void verifyStoredResource(ResourceRow resource) {
        if (!"MYSQL_INLINE".equals(resource.storageKind())
                || !"REFERENCED".equals(resource.state())
                || resource.bytes() == null
                || resource.objectKey() != null
                || resource.objectVersionId() != null
                || resource.encryptionKeyId() != null
                || resource.bytes().length != resource.byteLength()
                || !sha256(resource.bytes()).equals(resource.digest())) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "managed_session_resource_corrupt",
                    "The Managed Session resource failed verification.");
        }
    }

    private static void validateCounter(long value, String label,
            long minimum) {
        if (value < minimum
                || value > ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw invalid(label + " is outside its safe integer bound.");
        }
    }

    private static void validateLeaseMillis(Long leaseMillis) {
        if (leaseMillis == null
                || leaseMillis < ManagedSessionStoreModels.MIN_LEASE_MILLIS
                || leaseMillis > ManagedSessionStoreModels.MAX_LEASE_MILLIS) {
            throw invalid("leaseMillis is outside its bound.");
        }
    }

    private static void validateUtf8JsonLines(byte[] bytes,
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
                if (lineLength > 1024 * 1024) {
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

    private static void requireHeadScope(HeadRow head, String tenantId,
            String workspaceId, String sessionId) {
        if (!tenantId.equals(head.tenantId())
                || !workspaceId.equals(head.workspaceId())
                || !sessionId.equals(head.sessionId())) {
            throw sessionNotFound();
        }
        if (head.storageVersion() != STORAGE_VERSION) {
            throw conflict("managed_session_storage_version_unsupported",
                    "The Managed Session storage version is unsupported.");
        }
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

    private static void requireResourceScope(ResourceRow resource,
            String tenantId, String workspaceId, String sessionId,
            String resourceId) {
        if (!tenantId.equals(resource.tenantId())
                || !workspaceId.equals(resource.workspaceId())
                || !sessionId.equals(resource.sessionId())
                || !resourceId.equals(resource.resourceId())) {
            throw sessionNotFound();
        }
    }

    private static void requireTransactionWorkspace(TransactionRow row,
            String workspaceId) {
        if (!workspaceId.equals(row.workspaceId())) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                    "The Managed Session transaction scope is corrupt.");
        }
    }

    private static String tokenHash(String writerToken) {
        if (writerToken == null
                || !WRITER_TOKEN.matcher(writerToken).matches()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_writer_token",
                    ManagedSessionStoreModels.WRITER_TOKEN_HEADER
                            + " must contain 32-512 Base64URL characters.");
        }
        return sha256(writerToken.getBytes(StandardCharsets.UTF_8));
    }

    private static String sessionScopeKey(String tenantId,
            String sessionId) {
        return sha256((tenantId + "\u0000" + sessionId)
                .getBytes(StandardCharsets.UTF_8));
    }

    private static String commandKeyHash(String operation,
            String commandId) {
        return sha256((operation + "\u0000" + commandId)
                .getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static boolean secureEquals(String left, String right) {
        return left != null && right != null && MessageDigest.isEqual(
                left.getBytes(StandardCharsets.US_ASCII),
                right.getBytes(StandardCharsets.US_ASCII));
    }

    private static ApiException sessionNotFound() {
        return new ApiException(HttpStatus.NOT_FOUND,
                "managed_session_not_found",
                "The Managed Session does not exist.");
    }

    private static ApiException writerConflict() {
        return conflict(ManagedSessionStoreModels.ERROR_WRITER_CONFLICT,
                "The Managed Session writer grant is stale or unavailable.");
    }

    private static ApiException journalCorrupt() {
        return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                ManagedSessionStoreModels.ERROR_JOURNAL_CORRUPT,
                "The Managed Session transaction failed verification.");
    }

    private static ApiException headCorrupt() {
        return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                ManagedSessionStoreModels.ERROR_HEAD_CORRUPT,
                "The Managed Session head failed verification.");
    }

    private static ApiException invalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST,
                ManagedSessionStoreModels.ERROR_INVALID_REQUEST, message);
    }

    private static ApiException payloadTooLarge(String message) {
        return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE,
                ManagedSessionStoreModels.ERROR_PAYLOAD_TOO_LARGE, message);
    }

    private static ApiException conflict(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }

    private record HeadRow(String tenantId, String workspaceId,
            String sessionId, String state, int storageVersion,
            long writerGeneration, String writerId,
            Timestamp writerLeaseUntil, String leaseTokenHash,
            long journalRevision, long committedSequence,
            String lastCommitDigest, long activationEpoch,
            String latestCheckpointResourceId,
            long compactedThroughRevision, String recoveryStatus,
            String recoveryDetailCode) {
    }

    private record TransactionRow(String workspaceId, long journalRevision,
            String transactionId, String operation, String commandId,
            String contentDigest, long firstSequence, long lastSequence,
            int eventCount, String eventsDigest,
            String previousCommitDigest, String commitDigest,
            long writerGeneration, String writerId, String writerTokenHash,
            long activationEpoch, String latestCheckpointResourceId,
            String recordEncoding, byte[] recordBytes, long byteLength,
            String recordDigest) {
    }

    private record TransactionSize(long journalRevision, long byteLength) {
    }

    private record ResourceRow(String tenantId, String workspaceId,
            String sessionId, String resourceId, String kind,
            int schemaVersion, long byteLength, String digest,
            String storageKind, byte[] bytes, String objectKey,
            String objectVersionId, String encryptionKeyId, String state) {
    }

    private record ValidatedResource(CommitResource resource, byte[] bytes) {
    }

    private record ValidatedCommit(byte[] recordBytes, String recordDigest,
            List<ValidatedResource> resources) {
    }
}
