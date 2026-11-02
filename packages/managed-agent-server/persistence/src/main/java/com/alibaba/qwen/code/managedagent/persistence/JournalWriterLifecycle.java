package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHarnessReleaseRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RecoveryStateReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.List;
import java.util.Objects;

final class JournalWriterLifecycle {
    private final JournalFencing fencing;
    private final JournalStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion;
    private final JdbcTemplate jdbc;
    private final WriterCredentialPolicy credentials;
    private final JdbcRuntimeBindingRepository csiBindings;

    JournalWriterLifecycle(JournalFencing fencing,
            JournalStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion,
            JdbcTemplate jdbc,
            WriterCredentialPolicy credentials,
            JdbcRuntimeBindingRepository csiBindings) {
        this.fencing = fencing;
        this.storeRows = storeRows;
        this.readerVersion = readerVersion;
        this.jdbc = jdbc;
        this.credentials = credentials;
        this.csiBindings = csiBindings;
    }

    void bindControlSessionStorage(String tenantId, String workspaceId, String sessionId) {
        String storage = WorkspaceMigrationAdmission.sessionStorage(jdbc, tenantId, sessionId, workspaceId);
        if (storage == null) {
            return;
        }
        var rows = jdbc.queryForList("SELECT session_kind, workspace_id, workspace_storage_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenantId, sessionId);
        if (rows.size() != 1 || !"CONTROL".equals(rows.getFirst().get("session_kind"))) {
            return;
        }
        var row = rows.getFirst();
        if (row.get("workspace_id") != null && !workspaceId.equals(row.get("workspace_id"))
                || row.get("workspace_storage_id") != null && !storage.equals(row.get("workspace_storage_id"))) {
            throw JournalStoreRows.conflict("managed_session_scope_conflict", "The Managed Session Workspace binding conflicts.");
        }
        jdbc.update(
                "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", workspace_id = ?, workspace_storage_id = ? WHERE tenant_id ="
                        + " ? AND session_id = ? AND session_kind = 'CONTROL'",
                workspaceId, storage, tenantId, sessionId);
    }

    RestoreHead lockSnapshotWriter(String tenant, String session, String token,
            ManagedNativeJournalSnapshots.PublishRequest request) {
        JournalStoreRows.validateScope(tenant, request.workspaceId(), session);
        fencing.requireCredential(tenant, request.workspaceId(), session, token);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateStableId(request.snapshotId(), "snapshotId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        JournalStoreRows.validateCounter(request.expectedJournalRevision(), "expectedJournalRevision", 1);
        JournalStoreRows.validateCounter(request.expectedCommittedSequence(), "expectedCommittedSequence", 0);
        JournalStoreRows.validateDigest(request.expectedLastCommitDigest(), "expectedLastCommitDigest", true);
        JournalFencing.lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenant, JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        lockPublicationWriter(tenant, request.workspaceId(), session, request.writerId(), request.writerGeneration(), token);
        fencing.requireOrdinaryAdmission(tenant, session);
        JournalStoreRows.HeadRow locked = storeRows.requireHeadForUpdate(tenant, session);
        RestoreHead head = storeRows.restoreHead(locked);
        if (!"READY".equals(head.recoveryStatus())) {
            throw JournalStoreRows.conflict("managed_session_recovery_blocked", "The Session is blocked from snapshot publication.");
        }
        return head;
    }

    ManagedSessionStore.PublicationWriter lockPublicationWriter(String tenant, String workspace,
            String session, String writer, long generation, String token) {
        JournalStoreRows.validateScope(tenant, workspace, session);
        fencing.requireCredential(tenant, workspace, session, token);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenant, session);
        fencing.requirePhysicalSessionOpen(tenant, workspace, session);
        // Publication-lane writer: keeps the tenant CAS row before the
        // Session root the CSI check locks and before the head row, the
        // order retention reads take (CAS row, root, head) and the same as
        // before #13800 decoupled ordinary traffic.
        JournalFencing.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenant,
                JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        fencing.requirePlacement(tenant, workspace, session, token, writer, false);
        var continuation = fencing.lockCsiContinuation(tenant, session);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireAdmission();
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenant, session);
        storeRows.requireHeadScope(head, tenant, workspace, session);
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, writer, generation, token, now, true);
        fencing.requireInstalledCsiWriter(csiOriginal);
        return new ManagedSessionStore.PublicationWriter(JournalStoreRows.epochMillis(now), JournalStoreRows.epochMillis(head.writerLeaseUntil()),
                head.journalRevision(), head.committedSequence(), head.activationEpoch(),
                head.latestCheckpointResourceId(), head.recoveryStatus(), head.activationId(),
                head.activationPhase(), head.activationEventEpoch(), head.activationExpiresAt(),
                head.activationHeadRevision());
    }

    WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request) {
        return acquireWriter(tenantId, sessionId, writerToken, request, null);
    }

    WriterGrant acquireWriter(String tenantId, String sessionId, String writerToken,
            AcquireWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        fencing.checkLifecycleWriter(tenantId, sessionId, authority);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        validateLeaseMillis(request.leaseMillis());
        // Acquisition stays serialized with an in-flight delete/retire: while
        // a Session has no head row, the tenant CAS row is the only ordering
        // point, so it stays. Both acquisitions run in the codebase-wide
        // placement-before-publication order, bounded — a held row degrades
        // to a named failure instead of a silent wedge or a 1213 (#13800).
        // Placement must precede the drain admission check below: begin paths
        // insert drain rows only after locking placement, so checking the
        // drain first would take its gap lock and deadlock against a
        // lifecycle that already holds placement (#13800).
        // requireSessionOpen must run after the CAS guard: it is this
        // transaction's first consistent read, so its REPEATABLE READ
        // snapshot only sees a retirement committed underneath the CAS wait
        // if it is pinned after that wait (#13800 R2).
        JournalFencing.lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId,
                JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        JournalFencing.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc,
                tenantId, JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        var csiOriginal = fencing.lockCsiOriginal(tenantId, sessionId);
        if (csiOriginal != null) {
            csiOriginal.requireAdmission();
        }
        WorkspaceMigrationAdmission.requireSessionOpen(jdbc, tenantId, sessionId, request.workspaceId());
        storeRows.ensureSessionRoot(tenantId, sessionId);
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), true);
        bindControlSessionStorage(tenantId, request.workspaceId(), sessionId);
        // Materialize the key before any locking read: missing-key RR locks can
        // deadlock independent tenants when both first writers insert a head.
        jdbc.update("INSERT IGNORE INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, phase, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', 'OPEN', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId), JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId, sessionId, sessionId);
        if (authority != null) {
            WorkspaceLifecycleStore.requireClaim(jdbc, tenantId, sessionId, authority,
                    WorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority));
        } else {
            fencing.requireOrdinaryAdmission(tenantId, sessionId);
        }
        ToolPublicationRetentionStore.requireLive(jdbc, tenantId, sessionId);
        List<String> closed = jdbc.query(
                        "SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? AND"
                                + " (workspace_id IS NOT NULL OR session_kind = 'PUBLIC') FOR UPDATE",
                (row, index) -> row.getString("status"), tenantId, sessionId);
        if (authority == null && !closed.isEmpty() && !"ACTIVE".equals(closed.getFirst())) {
            throw JournalStoreRows.conflict("managed_session_not_writable", "The Session is closing or closed.");
        }
        String tokenHash = JournalFencing.tokenHash(writerToken);
        readerVersion.requireReadable(1);
        Timestamp createdAt = storeRows.databaseNow();
        Timestamp initialLeaseUntil = plusMillis(createdAt,
                request.leaseMillis());
        List<String> kinds =
                jdbc.queryForList(
                        "SELECT head_kind FROM ma_session_head WHERE tenant_key = ? AND harness_key"
                            + " = ? AND tenant_id = ? AND session_id = ? FOR UPDATE",
                        String.class,
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        if (!kinds.isEmpty() && "HARNESS".equals(kinds.getFirst())) {
            jdbc.update(
                    "UPDATE ma_session_head SET head_kind = 'MANAGED_SESSION', workspace_id = ?, storage_version = ?, state = 'ACTIVE', writer_generation = 1, writer_id = ?, writer_lease_until = ?, lease_token_hash = ?, journal_revision = 0, wake_head_revision = 0, cleanup_head_revision = 0, committed_sequence = 0, activation_epoch = 0, compacted_through_revision = 0, recovery_status = 'READY', gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'HARNESS'",
                    request.workspaceId(),
                    JournalStoreRows.STORAGE_VERSION,
                    request.writerId(),
                    initialLeaseUntil.getTime(),
                    tokenHash,
                    createdAt.getTime(),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId);
            return new WriterGrant(1, JournalStoreRows.epochMillis(initialLeaseUntil), 0, 0, null, 0, false);
        }
        try {
            jdbc.update(
                    "INSERT INTO ma_session_head (tenant_key, harness_key, harness_session_id, head_kind, tenant_id, workspace_id, session_id, storage_version, state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision, wake_head_revision, cleanup_head_revision, committed_sequence, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES (?, ?, ?, 'MANAGED_SESSION', ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'READY', ?, ?)",
                    com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository
                            .harnessDrainKey(tenantId),
                    com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository
                            .harnessDrainKey(sessionId),
                    sessionId,
                    tenantId,
                    request.workspaceId(),
                    sessionId,
                    JournalStoreRows.STORAGE_VERSION,
                    request.writerId(),
                    initialLeaseUntil.getTime(),
                    tokenHash,
                    createdAt.getTime(),
                    createdAt.getTime());
            return new WriterGrant(1, JournalStoreRows.epochMillis(initialLeaseUntil), 0, 0,
                    null, 0, false);
        } catch (DuplicateKeyException ignored) {
            // A prior acquire created the row; lock and inspect it below.
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        JournalFencing.requireCsiWriter(csiOriginal, head);
        if ("DELETING".equals(head.state())
                || "DELETED".equals(head.state())) {
            throw JournalStoreRows.conflict("managed_session_not_writable",
                    "The Managed Session does not accept a writer.");
        }
        if (!"ACTIVE".equals(head.state())
                && !"SEALED".equals(head.state())) {
            throw JournalStoreRows.conflict("managed_session_not_writable",
                    "The Managed Session state is not writable.");
        }
        Timestamp now = storeRows.databaseNow();
        if ("ACTIVE".equals(head.state())
                && head.writerLeaseUntil() != null
                && head.writerLeaseUntil().after(now)) {
            if (!request.writerId().equals(head.writerId())
                    || !JournalFencing.secureEquals(tokenHash, head.leaseTokenHash())) {
                throw JournalFencing.writerConflict();
            }
            Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                    plusMillis(now, request.leaseMillis()));
            jdbc.update(
                    "UPDATE ma_session_head SET writer_lease_until = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                    leaseUntil.getTime(),
                    now.getTime(),
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                    JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                    tenantId,
                    sessionId);
            return grant(head, leaseUntil, true);
        }
        long generation = JournalStoreRows.increment(head.writerGeneration(),
                "writer generation");
        if (csiOriginal != null) {
            if (!"ACTIVE".equals(head.state()) || head.storageVersion() != JournalStoreRows.STORAGE_VERSION
                    || head.compactedThroughRevision() != 0 || !"READY".equals(head.recoveryStatus())
                    || head.writerLeaseUntil() == null || head.journalRevision() < 2 || head.activationEpoch() < 1) {
                throw JournalStoreRows.conflict("csi_original_writer_unavailable", "The original CSI writer cannot be replaced.");
            }
            fencing.requireCsiHistoryOwner(csiOriginal);
            jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                JdbcCsiActivationAdmission.qualifyColdWriter(connection, csiOriginal, csiBindings,
                        head.journalRevision(), head.committedSequence(), head.lastCommitDigest(), head.writerId(),
                        head.writerGeneration(), head.activationEpoch(), JournalStoreRows.epochMillis(head.writerLeaseUntil()),
                        request.writerId());
                return null;
            });
            now = storeRows.databaseNow();
        }
        Timestamp leaseUntil = plusMillis(now, request.leaseMillis());
        jdbc.update(
                "UPDATE ma_session_head SET state = 'ACTIVE', writer_generation = ?, writer_id = ?, writer_lease_until = ?, lease_token_hash = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                generation,
                request.writerId(),
                leaseUntil.getTime(),
                tokenHash,
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new WriterGrant(generation, JournalStoreRows.epochMillis(leaseUntil),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), false);
    }

    WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request) {
        return renewWriter(tenantId, sessionId, writerToken, request, null);
    }

    WriterGrant renewWriter(String tenantId, String sessionId, String writerToken,
            RenewWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        fencing.checkLifecycleWriter(tenantId, sessionId, authority);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        validateLeaseMillis(request.leaseMillis());
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        var continuation = fencing.lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        JournalStoreRows.HeadRow head = continuation == null ? storeRows.requireHeartbeatHead(tenantId, sessionId) : storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (authority == null) {
            fencing.requireNoLifecycleClaim(tenantId, sessionId);
        }
        JournalFencing.requireCsiWriter(csiOriginal, head);
        Timestamp now = storeRows.databaseNow();
        boolean cleanup = authority != null && WorkspaceLifecycleStore.resourceClaim(jdbc, tenantId, sessionId, authority);
        // A resident cleanup writer may outlive its lease while the coordinator
        // is down; its token and generation must still own the locked head.
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, !cleanup);
        Timestamp leaseUntil = laterOf(head.writerLeaseUntil(),
                plusMillis(now, request.leaseMillis()));
        fencing.requireCsiLease(continuation, JournalStoreRows.epochMillis(head.writerLeaseUntil()), JournalStoreRows.epochMillis(leaseUntil));
        jdbc.update(
                "UPDATE ma_session_head SET writer_lease_until = ?, gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                leaseUntil.getTime(),
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        if (request.activation() != null) {
            var activation = request.activation();
            JournalStoreRows.validateStableId(activation.activationId(), "activationId");
            JournalStoreRows.validateCounter(activation.epoch(), "activation epoch", 1);
            JournalStoreRows.validateCounter(activation.renewalSeq(), "activation renewalSeq", 1);
            validateLeaseMillis(activation.leaseDurationMs());
            if (!"READY".equals(head.recoveryStatus()) || !"active".equals(head.activationPhase())
                    || !Objects.equals(head.activationHeadRevision(), head.journalRevision())
                    || !activation.activationId().equals(head.activationId())
                    || !Objects.equals(head.activationEventEpoch(), activation.epoch())) {
                throw JournalStoreRows.conflict("managed_session_activation_conflict", "The activation is no longer current.");
            }
            var row = storeRows.activationLeaseRow(head);
            if (!request.writerId().equals(row.workerId())
                    || activation.renewalSeq() < row.lease().renewalSeq()
                    || activation.renewalSeq() > row.lease().renewalSeq() + 1) {
                throw JournalStoreRows.conflict("managed_session_activation_conflict", "The activation renewal is stale or out of order.");
            }
            long until = row.lease().expiresAt();
            if (activation.renewalSeq() != row.lease().renewalSeq()) {
                until = Math.max(until, plusMillis(now, activation.leaseDurationMs()).getTime());
                fencing.requireCsiLease(continuation, row.lease().expiresAt(), until);
                jdbc.update("UPDATE ma_session_journal_tx SET activation_lease_until = ?, activation_renewal_seq = ?"
                                + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                        until, activation.renewalSeq(), tenantId, sessionId, row.revision());
                jdbc.update("UPDATE ma_session_head SET activation_expires_at = ?"
                                + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                        until, JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId, sessionId);
            }
            var lease = new ManagedSessionStoreModels.ActivationLease(
                    activation.activationId(), activation.epoch(), activation.renewalSeq(), until);
            return new WriterGrant(head.writerGeneration(), JournalStoreRows.epochMillis(leaseUntil), head.journalRevision(),
                    head.committedSequence(), head.lastCommitDigest(), head.activationEpoch(), false,
                    com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedStorageVersions.SUPPORTED, true, lease);
        }
        return grant(head, leaseUntil, false);
    }

    SealReceipt sealWriter(String tenantId, String sessionId,
            String writerToken, SealWriterRequest request) {
        return sealWriter(tenantId, sessionId, writerToken, request, null);
    }

    SealReceipt sealWriter(String tenantId, String sessionId, String writerToken,
            SealWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        fencing.checkLifecycleWriter(tenantId, sessionId, authority);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        if (fencing.lockCsiOriginal(tenantId, sessionId) != null) {
            throw JournalStoreRows.conflict(
                    "csi_finalize_required",
                    "The original CSI writer requires retirement finalization.");
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (authority == null) {
            fencing.requireNoLifecycleClaim(tenantId, sessionId);
        }
        if ("SEALED".equals(head.state())
                && request.writerGeneration() == head.writerGeneration()
                && request.writerId().equals(head.writerId())
                && JournalFencing.secureEquals(JournalFencing.tokenHash(writerToken),
                        head.leaseTokenHash())) {
            return new SealReceipt(head.writerGeneration(), "SEALED", true);
        }
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, false);
        jdbc.update(
                "UPDATE ma_session_head SET state = 'SEALED', gmt_modified = ? WHERE tenant_key = ?"
                    + " AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new SealReceipt(head.writerGeneration(), "SEALED", false);
    }

    void quiesceOwnership(String tenant, String session, String token,
            ManagedSessionStoreModels.QuiesceOwnershipRequest request) {
        JournalStoreRows.validateScope(tenant, request.workspaceId(), session);
        fencing.requireCredential(tenant, request.workspaceId(), session, token);
        credentials.requirePlacement(tenant, request.workspaceId(), session, request.instanceId(), request.bootId(),
                request.placementEpoch(), token);
        fencing.requirePlacement(tenant, request.workspaceId(), session, token, request.writerId(), false);
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenant, session);
        storeRows.requireHeadScope(head, tenant, request.workspaceId(), session);
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), token, storeRows.databaseNow(), true);
        jdbc.update("UPDATE ma_session SET harness_placement_state = 'QUIESCING' WHERE tenant_id = ? AND session_id = ?", tenant, session);
    }

    JsonNode releaseOwnership(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.ReleaseOwnershipRequest request) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId, writerToken);
        JournalStoreRows.validateStableId(request.operationId(), "operationId");
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        JournalStoreRows.validateCounter(request.journalRevision(), "journalRevision", 1);
        JournalStoreRows.validateCounter(request.placementEpoch(), "placementEpoch", 1);
        if (request.commitProof() == null || !request.bootId().equals(request.writerId())) {
            throw JournalStoreRows.invalid("Ownership release requires the original boot and committed prefix.");
        }
        JournalStoreRows.validateDigest(request.commitProof().committedPrefixHash(), "committedPrefixHash", false);
        credentials.requirePlacement(tenantId, request.workspaceId(), sessionId,
                request.instanceId(), request.bootId(), request.placementEpoch(), writerToken);
        JournalFencing.lockBounded(() -> WorkspaceLifecycleStore.lockPlacement(jdbc, tenantId, JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        JournalFencing.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc, tenantId, JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenantId, sessionId);
        String recordId = HarnessPlacementStore.releaseId(request.placementEpoch());
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        String recordKey = ManagedExtensionProjection.recordKey(sessionId, HarnessPlacementStore.RELEASE_DOMAIN, recordId);
        ObjectNode receipt = JournalStoreRows.CSI_JSON.createObjectNode();
        receipt.put("format", "qwen-hosted-harness-release/1");
        receipt.put("tenantId", tenantId);
        receipt.put("workspaceId", request.workspaceId());
        receipt.put("sessionId", sessionId);
        receipt.put("operationId", request.operationId());
        receipt.put("instanceId", request.instanceId());
        receipt.put("bootId", request.bootId());
        receipt.put("placementEpoch", request.placementEpoch());
        receipt.put("writerGeneration", request.writerGeneration());
        receipt.put("journalRevision", request.journalRevision());
        receipt.put("committedSequence", request.commitProof().lastCommitSequence());
        receipt.set("commitProof", JournalStoreRows.CSI_JSON.valueToTree(request.commitProof()));
        receipt.put("state", "RELEASED");
        // Normalize integer nodes to the representation read back from the stored JSON.
        receipt = (ObjectNode) com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(receipt.toString());
        var saved = jdbc.query("SELECT record_resource_id FROM ma_session_record WHERE session_scope_key = ?"
                + " AND record_key = ? AND tenant_id = ? AND session_id = ? AND domain = ? AND record_kind = 'DOMAIN'",
                (row, index) -> row.getString(1), scope, recordKey, tenantId, sessionId, HarnessPlacementStore.RELEASE_DOMAIN);
        if (!saved.isEmpty()) {
            var resource = storeRows.findResource(scope, saved.getFirst());
            if (resource == null) {
                throw HarnessPlacementStore.blocked("harness_release_receipt_missing");
            }
            storeRows.verifyStoredResource(resource);
            JsonNode original = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(new String(resource.bytes(), StandardCharsets.UTF_8));
            if (!receipt.equals(original)) {
                throw HarnessPlacementStore.blocked("harness_release_operation_conflict");
            }
            return original;
        }
        var placement = fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        if (placement == null || !"QUIESCING".equals(placement.state())) {
            throw HarnessPlacementStore.blocked("harness_placement_not_quiescing");
        }
        fencing.requireNoLifecycleClaim(tenantId, sessionId);
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, now, true);
        if (head.journalRevision() != request.journalRevision()
                || head.committedSequence() != request.commitProof().lastCommitSequence()
                || !Objects.equals(head.lastCommitDigest(), request.commitProof().committedPrefixHash())
                || !"released".equals(head.activationPhase())
                || !Objects.equals(head.activationHeadRevision(), head.journalRevision())) {
            throw HarnessPlacementStore.blocked("harness_release_proof_conflict");
        }
        String resourceId = "harness-release:" + request.placementEpoch();
        byte[] bytes;
        try {
            bytes = JournalStoreRows.CSI_JSON.writeValueAsBytes(receipt);
        } catch (com.fasterxml.jackson.core.JsonProcessingException failure) {
            throw new IllegalStateException("Ownership release receipt cannot be encoded.", failure);
        }
        ManagedHarnessReleaseRecords.require(receipt);
        String resourceKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, resourceId);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create, last_verified_at)"
                + " VALUES (?, ?, ?, ?, ?, ?, 'managed-hosted_harness_release', 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', ?, ?)",
                resourceKey, scope, tenantId, request.workspaceId(), sessionId, resourceId,
                bytes.length, JournalStoreRows.sha256(bytes), bytes, now.getTime(), now.getTime());
        jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id,"
                + " domain, record_id, operation_hash, revision, record_resource_id, gmt_create, settled_at, first_sequence)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", scope, recordKey, tenantId,
                request.workspaceId(), sessionId, HarnessPlacementStore.RELEASE_DOMAIN, recordId, JournalStoreRows.sha256(request.operationId().getBytes(StandardCharsets.UTF_8)),
                resourceId, now.getTime(), now.getTime(), head.committedSequence());
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key,"
                + " tenant_id, workspace_id, session_id, resource_id, gmt_create) VALUES (?, 'SESSION_RECORD', ?, 1, ?, ?, ?, ?, ?, ?)",
                scope, recordKey, resourceKey, tenantId, request.workspaceId(), sessionId, resourceId, now.getTime());
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED', gmt_modified = ? WHERE tenant_key = ? AND harness_key = ?"
                + " AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId), JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId, sessionId);
        jdbc.update("UPDATE ma_session SET harness_placement_state = 'RELEASED' WHERE tenant_id = ? AND session_id = ?",
                tenantId, sessionId);
        return receipt;
    }

    RecoveryStateReceipt blockRecovery(String tenantId,
            String sessionId, String writerToken,
            BlockRecoveryRequest request) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        if (!JournalStoreRows.RECOVERY_STATES.contains(request.recoveryStatus())
                || "READY".equals(request.recoveryStatus())) {
            throw JournalStoreRows.invalid("recoveryStatus must be a blocked state.");
        }
        // The 128-character column width is enforced one layer up by
        // @Size(max = 128) on BlockRecoveryRequest — byte-counting here
        // would reject non-ASCII codes that legitimately fit VARCHAR(128).
        JournalStoreRows.validateText(request.recoveryDetailCode(), "recoveryDetailCode",
                JournalStoreRows.MAX_TEXT_BYTES);
        fencing.requirePlacement(tenantId, request.workspaceId(), sessionId, writerToken, request.writerId(), false);
        var continuation = fencing.lockCsiContinuation(tenantId, sessionId);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenantId, sessionId);
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        JournalFencing.requireCsiWriter(csiOriginal, head);
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        fencing.requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        if (request.recoveryStatus().equals(head.recoveryStatus())
                && request.recoveryDetailCode()
                        .equals(head.recoveryDetailCode())) {
            return new RecoveryStateReceipt(head.writerGeneration(),
                    head.recoveryStatus(), head.recoveryDetailCode(), true);
        }
        if (!"READY".equals(head.recoveryStatus())) {
            throw JournalStoreRows.conflict(
                    ManagedSessionStoreModels.ERROR_RECOVERY_CONFLICT,
                    "The Managed Session already has a different recovery"
                            + " block.");
        }
        fencing.requireCsiWriterCurrent(continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update(
                "UPDATE ma_session_head SET recovery_status = ?, recovery_detail_code = ?,"
                    + " gmt_modified = ? WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                    + " AND session_id = ?",
                request.recoveryStatus(),
                request.recoveryDetailCode(),
                now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                tenantId,
                sessionId);
        return new RecoveryStateReceipt(head.writerGeneration(),
                request.recoveryStatus(), request.recoveryDetailCode(),
                false);
    }

    /**
     * Whether a writer still holds the Session's journal under a lease that has not expired by
     * database time. A Harness renews that lease while it holds the Session and seals the writer
     * when it closes the Session.
     */
    boolean hasLiveWriter(String tenantId, String sessionId) {
        List<Timestamp> leases =
                jdbc.query(
                        "SELECT writer_lease_until FROM ma_session_head WHERE tenant_key = ? AND"
                            + " harness_key = ? AND tenant_id = ? AND session_id = ? AND state ="
                            + " 'ACTIVE' FOR UPDATE",
                        (result, row) -> ManagedSchemaTime.timestamp(result, "writer_lease_until"),
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                        JdbcRuntimeBindingRepository.harnessDrainKey(sessionId),
                        tenantId,
                        sessionId);
        return !leases.isEmpty() && leases.getFirst() != null
                && leases.getFirst().after(storeRows.databaseNow());
    }

    WriterGrant grant(JournalStoreRows.HeadRow head, Timestamp leaseUntil,
            boolean replayed) {
        return new WriterGrant(head.writerGeneration(), JournalStoreRows.epochMillis(leaseUntil),
                head.journalRevision(), head.committedSequence(),
                head.lastCommitDigest(), head.activationEpoch(), replayed);
    }

    static Timestamp plusMillis(Timestamp timestamp, long millis) {
        return Timestamp.from(timestamp.toInstant().plusMillis(millis));
    }

    static Timestamp laterOf(Timestamp left, Timestamp right) {
        return left != null && left.after(right) ? left : right;
    }

    static void validateLeaseMillis(Long leaseMillis) {
        if (leaseMillis == null
                || leaseMillis < ManagedSessionStoreModels.MIN_LEASE_MILLIS
                || leaseMillis > ManagedSessionStoreModels.MAX_LEASE_MILLIS) {
            throw JournalStoreRows.invalid("leaseMillis is outside its bound.");
        }
    }
}
