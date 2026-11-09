package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHostedRecoveryRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.ManagedCheckpointHistory;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class JournalCommit {
    private final JournalFencing fencing;
    private final JournalLifecycleAuthorization lifecycleAuthorization;
    private final JournalResourceWrites resourceWrites;
    private final JournalStoreRows storeRows;
    private final com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion;
    private final JdbcTemplate jdbc;
    private final ManagedToolResultStore toolResults;
    private final JournalEventTransport journalEventTransport;
    private final ManagedExtensionRecordStore extensionRecords;
    private final ManagedActionStore actions;

    JournalCommit(JournalFencing fencing,
            JournalLifecycleAuthorization lifecycleAuthorization,
            JournalResourceWrites resourceWrites,
            JournalStoreRows storeRows,
            com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion,
            JdbcTemplate jdbc,
            ManagedToolResultStore toolResults,
            JournalEventTransport journalEventTransport,
            ManagedExtensionRecordStore extensionRecords,
            ManagedActionStore actions) {
        this.fencing = fencing;
        this.lifecycleAuthorization = lifecycleAuthorization;
        this.resourceWrites = resourceWrites;
        this.storeRows = storeRows;
        this.readerVersion = readerVersion;
        this.jdbc = jdbc;
        this.toolResults = toolResults;
        this.journalEventTransport = journalEventTransport;
        this.extensionRecords = extensionRecords;
        this.actions = actions;
    }

    CommitReceipt commit(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId,
                writerToken);
        fencing.checkLifecycleWriter(tenantId, sessionId, authority);
        JournalStoreRows.validateStableId(request.writerId(), "writerId");
        ValidatedCommit validated = validateCommit(request);
        if (HostedCleanupReferences.containsCleanup(validated.recordBytes())) {
            fencing.lockPlacementBounded(tenantId);
        }
        // Other ordinary commits queue on their Session before any consistent
        // read, so lifecycle and placement cannot change it mid-commit. Cleanup
        // commits already hold placement; lifecycle authority holds both guards.
        // CSI-pinned Sessions take them behind this root in
        // lockCsiContinuation (design 2026-11-03-managed-journal-commit-tenant-guard).
        Boolean rootPin = fencing.lockSessionFirst(tenantId, sessionId);
        HarnessPlacementStore.Placement placement = fencing.requirePlacement(tenantId, request.workspaceId(),
                sessionId, writerToken, request.writerId(), false);
        int storageFloor = ManagedModelDiagnosticProjection.storageFloor(validated.recordBytes(), request.resources(), validated.resources());
        if (storageFloor > 1) {
            readerVersion.requireReadable(storageFloor);
        }
        var continuation = fencing.lockCsiContinuation(tenantId, sessionId, rootPin);
        var csiOriginal = continuation == null ? null : continuation.original();
        if (csiOriginal != null) {
            csiOriginal.requireContinuation();
        }
        JournalStoreRows.HeadRow csiHead = csiOriginal == null ? null : fencing.requireHeadAfterCsiCheck(tenantId, sessionId);
        if (csiOriginal != null && !com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile.supportsStorage(
                csiOriginal.request().getScope(), Math.max(csiHead.storageVersion(), storageFloor))) {
            throw JournalStoreRows.invalid("This CSI profile does not admit the requested storage format.");
        }
        JournalFencing.requireCsiWriter(csiOriginal, csiHead);
        if (csiOriginal != null
                && ("commitFileHistory".equals(request.operation())
                        || !jdbc.query(
                                        "SELECT journal_revision FROM ma_session_journal_tx WHERE"
                                            + " tenant_id = ? AND session_id = ? AND operation ="
                                            + " 'commitFileHistory' ORDER BY journal_revision LIMIT"
                                            + " 1 FOR UPDATE",
                                        (row, index) -> row.getLong(1),
                                        tenantId,
                                        sessionId)
                                .isEmpty())) {
            fencing.requireCsiHistoryOwner(csiOriginal);
        }
        JournalStoreRows.TransactionRow existing = storeRows.findTransactionByCommand(tenantId,
                sessionId, JournalStoreRows.commandKeyHash(request.operation(),
                        request.commandId()));
        if (existing != null) {
            JournalStoreRows.requireTransactionWorkspace(existing, request.workspaceId());
            if (csiOriginal != null) {
                fencing.requireWriter(
                        csiHead,
                        request.writerId(),
                        request.writerGeneration(),
                        writerToken,
                        storeRows.databaseNow(),
                        true);
                jdbc.execute(
                        (org.springframework.jdbc.core.ConnectionCallback<Void>)
                                connection -> {
                                    JdbcCsiActivationAdmission.requireReplay(
                                            connection,
                                            csiOriginal,
                                            csiHead.journalRevision(),
                                            csiHead.committedSequence(),
                                            csiHead.lastCommitDigest(),
                                            csiHead.writerId());
                                    return null;
                                });
                fencing.requireCsiCurrentTime(continuation);
            }
            // A duplicate is fenced like a first attempt: before #13800 the
            // v2 claim check ran ahead of this lookup.
            if (authority == null) {
                fencing.requireNoLifecycleClaim(tenantId, sessionId);
            }
            return replay(existing, request, validated.recordDigest(),
                    writerToken);
        }
        // Physical fencing and migration require stopped writers. Ordinary
        // commits only read storage state and need not block member updates.
        if (authority == null && csiOriginal == null) {
            fencing.requireSessionStorageOpenForRead(tenantId, request.workspaceId(), sessionId);
        } else {
            fencing.requireSessionStorageOpen(tenantId, request.workspaceId(), sessionId);
        }
        JournalStoreRows.HeadRow head = csiHead == null
                ? fencing.requireHeadAfterCsiCheck(tenantId, sessionId) : csiHead;
        storeRows.requireHeadScope(head, tenantId, request.workspaceId(), sessionId);
        if (head.storageVersion() >= 4) {
            JsonNode activity = extensionRecords.findActivityStatistics(tenantId, sessionId);
            if (activity == null || !"ready".equals(activity.path("readiness").asText())) {
                throw JournalStoreRows.conflict("managed_activity_rebuilding", "Session diagnostics are being restored before writer admission.");
            }
        }
        if (authority == null) {
            fencing.requireNoLifecycleClaim(tenantId, sessionId);
        }
        Timestamp now = storeRows.databaseNow();
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(),
                writerToken, now, true);
        validateHead(head, request);
        long revision = JournalStoreRows.increment(head.journalRevision(),
                "journal revision");
        String scopeKey = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        if (csiOriginal != null
                && java.util.Set.of("commitFileHistory", "toolIntent", "commitCheckpoint")
                        .contains(request.operation())) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.preflightCommit(
                                        connection,
                                        csiOriginal,
                                        JournalStoreRows.CSI_JSON.valueToTree(request),
                                        com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof
                                                .records(validated.recordBytes()),
                                        head.journalRevision(),
                                        head.committedSequence(),
                                        head.lastCommitDigest(),
                                        head.writerId());
                                return null;
                            });
            fencing.requireWriter(
                    head,
                    request.writerId(),
                    request.writerGeneration(),
                    writerToken,
                    storeRows.databaseNow(),
                    true);
        }
        resourceWrites.commitResources(scopeKey, tenantId, sessionId, request, revision,
                now, validated.resources(),
                () -> fencing.requireCsiCurrentTime(continuation));
        Set<String> declaredResources = new HashSet<>();
        for (var resource : request.resources() == null ? List.<CommitResource>of() : request.resources()) {
            declaredResources.add(resource.resourceId());
        }
        var resourceCache = new HashMap<String, StoredResource>();
        var hostedReferences = new HashMap<String, JsonNode>();
        java.util.function.Function<String, StoredResource> reader = resourceId -> resourceCache.computeIfAbsent(resourceId,
                id -> storeRows.storedResource(scopeKey, tenantId, request.workspaceId(), sessionId, id));
        ManagedHostedRecoveryRecords.HistoricalResources closureReader = new ManagedHostedRecoveryRecords.HistoricalResources() {
            @Override
            public StoredResource apply(String resourceId) {
                if (!declaredResources.contains(resourceId)) {
                    throw JournalStoreRows.invalid("Hosted nested reference is absent from the transaction census.");
                }
                return reader.apply(resourceId);
            }

            @Override
            public void checkpointHistory(JsonNode ref) {
                validateCheckpointHistory(ref, tenantId, request.workspaceId(), sessionId,
                        head.journalRevision(), declaredResources, reader);
            }
        };
        for (var resource : request.resources() == null ? List.<CommitResource>of() : request.resources()) {
            if (ManagedCheckpointHistory.KIND.equals(resource.kind())) {
                ObjectNode ref = JournalStoreRows.CSI_JSON.valueToTree(resource);
                ref.remove("bytesBase64");
                closureReader.checkpointHistory(ref);
            } else if ("managed-checkpoint".equals(resource.kind())) {
                validatePagedCheckpoint(closureReader.apply(resource.resourceId()), tenantId, request.workspaceId(), sessionId, closureReader);
            }
            if (ManagedHostedRecoveryRecords.KINDS.contains(resource.kind()) || "managed-action-options".equals(resource.kind())) {
                ManagedHostedRecoveryRecords.validateResource(closureReader.apply(resource.resourceId()), tenantId,
                        request.workspaceId(), sessionId, closureReader, hostedReferences);
            }
            if (com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedModelDiagnostics.KINDS.contains(resource.kind())) {
                ManagedModelDiagnosticProjection.validateResource(closureReader.apply(resource.resourceId()));
            }
            if (com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics.KIND.equals(resource.kind())) {
                StoredResource evidence = closureReader.apply(resource.resourceId());
                ManagedExtensionRecordStore.require(evidence.schemaVersion() == 1 && evidence.byteLength() <= 65_536,
                        "Invalid execution diagnostic resource.");
                com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics.requireEvidence(
                        ManagedExtensionRecordStore.readBody(evidence));
            }
        }
        List<JsonNode> diagnosticEvents = new ArrayList<>();
        boolean wakeInput = false;
        for (String line :
                new String(validated.recordBytes(), StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(line);
            if (record != null && record.has("managedSession")) {
                JsonNode event = record.get("managedSession");
                if (event.isObject() && event.has("kind")) {
                    diagnosticEvents.add(event);
                }
                wakeInput |= WakeRecoveryStore.isWakeInput(event);
                ManagedHostedRecoveryRecords.validateEvent(
                        event.path("kind").asText(),
                        event.path("payload"),
                        tenantId,
                        request.workspaceId(),
                        sessionId,
                        closureReader,
                        hostedReferences);
                if ("hosted.cleanup".equals(event.path("kind").asText())) {
                    HostedCleanupReferences.apply(jdbc, tenantId, request.workspaceId(), sessionId,
                            event.path("payload"), reader, revision, now.getTime());
                }
            }
        }
        lifecycleAuthorization.authorizeNewLifecycleDispatch(tenantId, sessionId, authority,
                validated.recordBytes(), reader);
        if (diagnosticEvents.stream().anyMatch(event -> event.path("payload").has("diagnosticsRef"))) {
            ManagedExtensionRecordStore.require(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics
                    .carrierDigest(diagnosticEvents).equals(request.contentDigest()), "Execution diagnostic commit digest conflicts.");
        }
        if (authority == null && fencing.lifecycleProtocolFenced(tenantId, sessionId)) {
            extensionRecords.requireLifecycleSettlement(tenantId, sessionId, validated.recordBytes(),
                    reader);
        }
        var applied =
                csiOriginal == null
                        ? extensionRecords.apply(tenantId, request.workspaceId(), sessionId,
                request.firstSequence(), request.eventCount(),
                validated.recordBytes(), reader, now.getTime())
                        : extensionRecords.applyNative(
                                tenantId,
                                request.workspaceId(),
                                sessionId,
                                request.firstSequence(),
                                request.eventCount(),
                                validated.recordBytes(),
                                reader,
                                now.getTime());
        if (csiOriginal != null) {
            jdbc.execute(
                    (org.springframework.jdbc.core.ConnectionCallback<Void>)
                            connection -> {
                                JdbcCsiActivationAdmission.acceptCommit(
                                        org.springframework.jdbc.datasource.DataSourceUtils
                                                .getTargetConnection(connection),
                                        csiOriginal,
                                        JournalStoreRows.CSI_JSON.valueToTree(request),
                                        applied.records(),
                                        head.journalRevision(),
                                        head.committedSequence(),
                                        head.lastCommitDigest(),
                                        head.writerId(),
                                        now.toInstant().toEpochMilli(),
                                        continuation.progress());
                                return null;
                            });
            fencing.requireWriter(
                    head,
                    request.writerId(),
                    request.writerGeneration(),
                    writerToken,
                    storeRows.databaseNow(),
                    true);
        }
        var receiptEvents = applied.receipts();
        if (actions != null) {
            actions.apply(
                    tenantId,
                    request.workspaceId(),
                    sessionId, request.firstSequence(), request.eventCount(),
                    validated.recordBytes(),
                    reader, hostedReferences);
        }
        fencing.requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update("INSERT INTO ma_session_journal_tx"
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
                        + " record_digest, gmt_create) VALUES (?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " ?,"
                        + " 'identity', ?, ?, ?, ?)",
                tenantId, request.workspaceId(), sessionId, revision,
                JournalStoreRows.commandKeyHash(request.operation(), request.commandId()),
                request.transactionId(), request.operation(),
                request.commandId(), request.contentDigest(),
                request.firstSequence(), request.lastSequence(),
                request.eventCount(), request.eventsDigest(),
                request.previousCommitDigest(), request.commitDigest(),
                request.writerGeneration(), request.writerId(),
                JournalFencing.tokenHash(writerToken), request.activationEpoch(),
                request.latestCheckpointResourceId(),
                validated.recordBytes(), validated.recordBytes().length,
                validated.recordDigest(), now.getTime());
        var activation = JournalStoreRows.activationChange(
                applied.lastActivation());
        if (placement != null && "QUIESCING".equals(placement.state()) && activation != null
                && "active".equals(activation.phase())
                && (!"active".equals(head.activationPhase()) || !Objects.equals(activation.id(), head.activationId())
                        || !Objects.equals(activation.epoch(), head.activationEventEpoch()))) {
            throw HarnessPlacementStore.blocked("harness_placement_quiescing");
        }
        // Never certify a skewed activation projection as current.
        Long activationHeadRevision = head.activationHeadRevision();
        if (activation != null || (activationHeadRevision != null
                && activationHeadRevision == head.journalRevision())) {
            activationHeadRevision = revision;
        }
        fencing.requireCsiWriterCurrent(
                continuation, head, request.writerId(), request.writerGeneration(), writerToken);
        jdbc.update("UPDATE ma_session_head SET"
                        + " journal_revision = ?, committed_sequence = ?,"
                        + " is_wake_pending = is_wake_pending OR ?,"
                        + " wake_head_revision = CASE WHEN wake_head_revision = ? THEN ? ELSE wake_head_revision END,"
                        + " cleanup_head_revision = CASE WHEN cleanup_head_revision = ? THEN ? ELSE cleanup_head_revision END,"
                        + " last_commit_digest = ?, activation_epoch = ?,"
                        + " latest_checkpoint_resource_id = COALESCE(?,"
                        + " latest_checkpoint_resource_id),"
                        + " activation_id = ?, activation_phase = ?,"
                        + " activation_event_epoch = ?,"
                        + " activation_expires_at = ?,"
                        + " activation_head_revision = ?, storage_version = ?, gmt_modified = ?"
                        + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                        + " AND session_id = ?",
                revision, request.lastSequence(),
                wakeInput,
                head.journalRevision(), revision, head.journalRevision(), revision, request.commitDigest(),
                request.activationEpoch(),
                request.latestCheckpointResourceId(),
                activation == null ? head.activationId()
                        : activation.id(),
                activation == null ? head.activationPhase()
                        : activation.phase(),
                activation == null ? head.activationEventEpoch()
                        : Long.valueOf(activation.epoch()),
                activation == null ? head.activationExpiresAt()
                        : activation.expiresAt(),
                activationHeadRevision, Math.max(head.storageVersion(), storageFloor), now.getTime(), JdbcRuntimeBindingRepository.harnessDrainKey(tenantId), JdbcRuntimeBindingRepository.harnessDrainKey(sessionId), tenantId, sessionId);
        if (toolResults != null && csiOriginal == null) {
            toolResults.captureEvents(tenantId, request.workspaceId(), sessionId, revision, receiptEvents);
        }
        ManagedUserMessageStore.capture(jdbc, tenantId, sessionId, applied.records());
        publishJournalAfterCommit(validated.recordBytes());
        return new CommitReceipt(revision, request.transactionId(),
                request.commandId(), request.operation(),
                request.firstSequence(), request.lastSequence(),
                request.lastSequence(), request.commitDigest(), false);
    }

    // The authoritative-journal wire (design 2026-10-04-managed-agent-event-transport,
    // MQ2b): hands the committed journal record to the transport only after the
    // transaction is durable, and never from a replayed commit (those return
    // before this point). A no-op when no transport is enabled.
    void publishJournalAfterCommit(byte[] recordBytes) {
        JournalEventTransport transport = journalEventTransport;
        if (transport == null) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            transport.publishCommitted(recordBytes);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        transport.publishCommitted(recordBytes);
                    }
                });
    }

    void persistTransaction(
            String tenantId,
            String sessionId,
            String writerTokenHash,
            CommitTransactionRequest request,
            long revision,
            ValidatedCommit validated,
            Timestamp now) {
        jdbc.update(
                "INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, events_digest, previous_commit_digest, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch, latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'identity', ?, ?, ?, ?)",
                tenantId,
                request.workspaceId(),
                sessionId,
                revision,
                JournalStoreRows.commandKeyHash(request.operation(), request.commandId()),
                request.transactionId(),
                request.operation(),
                request.commandId(),
                request.contentDigest(),
                request.firstSequence(),
                request.lastSequence(),
                request.eventCount(),
                request.eventsDigest(),
                request.previousCommitDigest(),
                request.commitDigest(),
                request.writerGeneration(),
                request.writerId(),
                writerTokenHash,
                request.activationEpoch(),
                request.latestCheckpointResourceId(),
                validated.recordBytes(),
                validated.recordBytes().length,
                validated.recordDigest(),
                now.getTime());
    }

    ManagedSessionStore.TerminalCandidate preflightCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requirePreCut(target);
        if (!org.springframework.jdbc.datasource.DataSourceUtils.isConnectionTransactional(
                org.springframework.jdbc.datasource.DataSourceUtils.getTargetConnection(target), jdbc.getDataSource())
                || bindings == null || !bindings.usesDataSource(jdbc.getDataSource())
                || exactBody == null || exactBody.length == 0 || exactBody.length > 128 * 1024) {
            throw JournalFencing.nativeReadConflict();
        }
        var original = authority.original();
        CommitTransactionRequest request = csiTerminalRequest(exactBody);
        String tenant = original.request().getScope().getTenantId();
        String session = original.request().getIsolationKey();
        JournalStoreRows.validateScope(tenant, request.workspaceId(), session);
        fencing.requireCredential(tenant, request.workspaceId(), session, writerToken);
        fencing.requireCsiJournalIsolation();
        validateCommit(request);
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenant, session);
        storeRows.requireHeadScope(head, tenant, request.workspaceId(), session);
        JournalFencing.requireCsiWriter(original, head);
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, storeRows.databaseNow(), true);
        validateHead(head, request);
        var proof = JdbcCsiActivationAdmission.terminalPreflight(target, authority, JournalStoreRows.CSI_JSON.valueToTree(request), bindings);
        return new ManagedSessionStore.TerminalCandidate(request, proof, head.leaseTokenHash());
    }

    String commitCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requireConnection(target);
        if (authority.stage() != com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Stage.FROZEN) {
            throw JournalFencing.nativeReadConflict();
        }
        var frozen = WorkspaceCsiApplicationJson.object(authority.frozenBytes(), WorkspaceCsiApplicationInventory.MAX_BYTES);
        byte[] saved = WorkspaceCsiApplicationJson.base64(frozen.path("commitBodyBase64"), 128 * 1024);
        if (!java.util.Arrays.equals(saved, exactBody)
                || !com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.sha256(saved)
                        .equals(frozen.path("preparedCommitSha256").textValue())) {
            throw JournalFencing.nativeReadConflict();
        }
        var candidate = preflightCsiTerminal(target, authority, writerToken, exactBody, bindings);
        var request = candidate.request();
        String tenant = authority.original().request().getScope().getTenantId();
        String session = authority.original().request().getIsolationKey();
        JournalStoreRows.HeadRow head = storeRows.requireHeadForUpdate(tenant, session);
        var validated = validateCommit(request);
        Timestamp now = storeRows.databaseNow();
        String writtenAt = now.toInstant().toString();
        long revision = JournalStoreRows.increment(head.journalRevision(), "journal revision");
        Runnable fence = () -> {
            try {
                authority.requireCurrentTime(target);
            } catch (SQLException error) {
                throw new org.springframework.dao.DataAccessResourceFailureException("Original terminal time is unavailable", error);
            }
            fencing.requireWriter(head, request.writerId(), request.writerGeneration(), writerToken, storeRows.databaseNow(), true);
        };
        resourceWrites.commitResources(com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), tenant, session, request, revision, now, validated.resources(), fence);
        fence.run();
        persistTransaction(tenant, session, candidate.writerTokenSha256(), request, revision, validated, now);
        fence.run();
        int changed = jdbc.update("UPDATE ma_session_head SET state = 'SEALED',"
                        + " journal_revision = ?, wake_head_revision = CASE WHEN wake_head_revision = ? THEN ? ELSE wake_head_revision END, committed_sequence = ?, last_commit_digest = ?,"
                        + " activation_phase = 'released', activation_head_revision = ?, gmt_modified = ?"
                        + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND state = 'ACTIVE'"
                        + " AND journal_revision = ? AND committed_sequence = ? AND last_commit_digest = ?",
                revision, head.journalRevision(), revision, candidate.proof().terminalSequence(), request.commitDigest(), revision, now.getTime(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session), tenant, session,
                head.journalRevision(), head.committedSequence(), head.lastCommitDigest());
        if (changed != 1) {
            throw JournalFencing.nativeReadConflict();
        }
        authority.requireCurrentTime(target);
        return writtenAt;
    }

    static CommitTransactionRequest csiTerminalRequest(byte[] bytes) {
        WorkspaceCsiApplicationJson.object(bytes, 128 * 1024);
        try {
            return JournalStoreRows.CSI_TERMINAL_JSON.readValue(bytes, CommitTransactionRequest.class);
        } catch (IOException malformed) {
            throw JournalStoreRows.invalid("Invalid original terminal request.");
        }
    }

    static CommitTransactionRequest validateCsiTerminalBytes(byte[] bytes) {
        var request = csiTerminalRequest(bytes);
        validateCommit(request);
        return request;
    }

    void validatePagedCheckpoint(StoredResource stored, String tenant, String workspace, String session,
            ManagedHostedRecoveryRecords.HistoricalResources resources) {
        JsonNode body = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
        if (body == null || !ManagedCheckpointHistory.paged(body)) {
            return;
        }
        if (!ManagedCheckpointHistory.PROFILE.equals(body.path("storageProfile").asText())) {
            throw JournalStoreRows.invalid("Unsupported checkpoint storage profile.");
        }
        JsonNode history = body.path("history");
        ManagedExtensionRecords.closed(history, Set.of("ref", "toolCount", "bindingCount"), "checkpoint history");
        resources.checkpointHistory(history.path("ref"));
        StoredResource page = resources.apply(history.path("ref").path("resourceId").asText());
        JsonNode saved = ManagedCheckpointHistory.page(page.bytes());
        if (!saved.path("sessionKey").equals(body.path("identity").path("sessionKey"))
                || !saved.path("turnId").equals(body.path("identity").path("turnId"))
                || !saved.path("promptId").equals(body.path("identity").path("promptId"))
                || !saved.path("toolCount").equals(history.path("toolCount"))
                || !saved.path("bindingCount").equals(history.path("bindingCount"))) {
            throw JournalStoreRows.invalid("Checkpoint history identity or coverage conflicts.");
        }
    }

    void validateCheckpointHistory(JsonNode ref, String tenant, String workspace, String session,
            long previousRevision, Set<String> declared, java.util.function.Function<String, StoredResource> resources) {
        try {
            ManagedCheckpointHistory.pageRef(ref);
            StoredResource stored = resources.apply(ref.path("resourceId").asText());
            requireCheckpointResource(ref, stored);
            JsonNode page = ManagedCheckpointHistory.page(stored.bytes());
            JsonNode key = page.path("sessionKey");
            if (!tenant.equals(key.path("tenantId").asText()) || !workspace.equals(key.path("workspaceId").asText())
                    || !session.equals(key.path("sessionId").asText())) {
                throw JournalStoreRows.invalid("Checkpoint history belongs to another Session.");
            }
            Long origin = priorCheckpointResourceRevision(tenant, workspace, session, stored.resourceId(), previousRevision);
            long ceiling = origin == null ? previousRevision : origin;
            for (JsonNode nested : checkpointReferences(page)) {
                StoredResource dependency = resources.apply(nested.path("resourceId").asText());
                requireCheckpointResource(nested, dependency);
                Long owned = priorCheckpointResourceRevision(tenant, workspace, session, dependency.resourceId(), ceiling);
                if (owned == null && (origin != null || !declared.contains(dependency.resourceId()))) {
                    throw JournalStoreRows.invalid("Checkpoint history dependency has no committed owner.");
                }
            }
            long tools = page.path("toolCount").longValue() - page.path("items").size();
            long bindings = page.path("bindingCount").longValue() - page.path("bindings").size();
            JsonNode previous = page.path("previous");
            if (tools < 0 || bindings < 0) {
                throw JournalStoreRows.invalid("Checkpoint history count conflicts.");
            }
            if (previous.isNull()) {
                if (tools != 0 || bindings != 0) {
                    throw JournalStoreRows.invalid("Checkpoint history predecessor is missing.");
                }
            } else {
                JsonNode predecessor = ManagedCheckpointHistory.page(resources.apply(previous.path("resourceId").asText()).bytes());
                if (!predecessor.path("sessionKey").equals(key)
                        || !predecessor.path("turnId").equals(page.path("turnId"))
                        || !predecessor.path("promptId").equals(page.path("promptId"))
                        || predecessor.path("toolCount").longValue() != tools
                        || predecessor.path("bindingCount").longValue() != bindings) {
                    throw JournalStoreRows.invalid("Checkpoint history predecessor conflicts.");
                }
            }
        } catch (IllegalArgumentException | com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException error) {
            throw JournalStoreRows.invalid("Invalid checkpoint history page.");
        }
    }

    static void requireCheckpointResource(JsonNode ref, StoredResource stored) {
        ManagedExtensionRecords.durableRef(ref, "checkpoint history dependency");
        if (!stored.kind().equals(ref.path("kind").asText())
                || stored.schemaVersion() != ref.path("schemaVersion").intValue()
                || stored.byteLength() != ref.path("byteLength").longValue()
                || !stored.digest().equals(ref.path("digest").asText())
                || stored.bytes() == null || stored.bytes().length != stored.byteLength()
                || !ToolPublicationContract.sha256(stored.bytes()).equals(stored.digest())) {
            throw JournalStoreRows.invalid("Checkpoint history resource metadata conflicts.");
        }
    }

    static List<JsonNode> checkpointReferences(JsonNode value) {
        List<JsonNode> result = new ArrayList<>();
        if (value.isObject() && value.has("resourceId")) {
            result.add(value);
        } else if (value.isContainerNode()) {
            for (JsonNode child : value) {
                result.addAll(checkpointReferences(child));
            }
        }
        return result;
    }

    Long priorCheckpointResourceRevision(String tenant, String workspace, String session,
            String resourceId, long maximum) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session);
        List<Long> origins = jdbc.query("SELECT x.owner_revision FROM ma_resource_ref x JOIN ma_session_journal_tx t"
                        + " ON t.tenant_id = x.tenant_id AND t.workspace_id = x.workspace_id AND t.session_id = x.session_id"
                        + " AND t.journal_revision = x.owner_revision WHERE x.resource_key = ? AND x.session_scope_key = ?"
                        + " AND x.tenant_id = ? AND x.workspace_id = ? AND x.session_id = ? AND x.resource_id = ?"
                        + " AND x.owner_kind = 'JOURNAL' AND x.owner_key = ? AND x.owner_revision = x.journal_revision"
                        + " AND x.owner_revision <= ? ORDER BY x.owner_revision LIMIT 1",
                (row, index) -> row.getLong(1), com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, resourceId), scope, tenant, workspace, session,
                resourceId, scope, maximum);
        return origins.isEmpty() ? null : origins.getFirst();
    }

    static ValidatedCommit validateCommit(
            CommitTransactionRequest request) {
        JournalStoreRows.validateStableId(request.transactionId(), "transactionId");
        JournalStoreRows.validateText(request.operation(), "operation", JournalStoreRows.MAX_TEXT_BYTES);
        JournalStoreRows.validateStableId(request.commandId(), "commandId");
        JournalStoreRows.validateDigest(request.contentDigest(), "contentDigest", false);
        JournalStoreRows.validateDigest(request.eventsDigest(), "eventsDigest", true);
        JournalStoreRows.validateDigest(request.previousCommitDigest(),
                "previousCommitDigest", true);
        JournalStoreRows.validateDigest(request.commitDigest(), "commitDigest", true);
        JournalStoreRows.validateDigest(request.recordDigest(), "recordDigest", false);
        JournalStoreRows.validateCounter(request.writerGeneration(), "writerGeneration", 1);
        JournalStoreRows.validateCounter(request.expectedJournalRevision(),
                "expectedJournalRevision", 0);
        JournalStoreRows.validateCounter(request.expectedCommittedSequence(),
                "expectedCommittedSequence", 0);
        JournalStoreRows.validateCounter(request.firstSequence(), "firstSequence", 0);
        JournalStoreRows.validateCounter(request.lastSequence(), "lastSequence", 0);
        JournalStoreRows.validateCounter(request.activationEpoch(), "activationEpoch", 0);
        if (request.latestCheckpointResourceId() != null) {
            JournalStoreRows.validateStableId(request.latestCheckpointResourceId(),
                    "latestCheckpointResourceId");
        }
        if (request.eventCount() < 0
                || request.eventCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                || request.recordCount() < 1
                || request.recordCount()
                        > ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                                + 1) {
            throw JournalStoreRows.invalid("eventCount or recordCount is outside its bound.");
        }
        byte[] recordBytes = JournalStoreRows.decodeBase64(request.recordBytesBase64(),
                ManagedSessionStoreModels.MAX_TRANSACTION_BYTES,
                "recordBytesBase64");
        if (!JournalStoreRows.sha256(recordBytes).equals(request.recordDigest())) {
            throw JournalStoreRows.invalid("recordDigest does not match recordBytesBase64.");
        }
        JournalStoreRows.validateUtf8JsonLines(recordBytes, request.recordCount());
        if ("session.create".equals(request.operation())) {
            if (request.eventCount() != 0 || request.firstSequence() != 0
                    || request.lastSequence() != 0
                    || request.recordCount() != 2
                    || request.eventsDigest() != null
                    || request.previousCommitDigest() != null
                    || request.commitDigest() != null
                    || request.latestCheckpointResourceId() != null) {
                throw JournalStoreRows.invalid("The session.create transaction must use"
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
                throw JournalStoreRows.invalid("The transaction event range or record count"
                        + " is invalid.");
            }
        }
        List<JournalResourceWrites.ValidatedResource> resources = new ArrayList<>();
        long inlineBytes = 0;
        List<CommitResource> requestedResources = request.resources() == null
                ? List.of() : request.resources();
        if (requestedResources.size()
                > ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION) {
            throw JournalStoreRows.invalid("resources exceeds its item limit.");
        }
        for (CommitResource resource : requestedResources) {
            if (resource == null) {
                throw JournalStoreRows.invalid("resources must not contain null entries.");
            }
            JournalStoreRows.validateStableId(resource.resourceId(), "resourceId");
            JournalStoreRows.validateStableId(resource.kind(), "resource kind");
            if (ManagedNativeJournalSnapshots.isSnapshotKind(resource.kind())
                    || ManagedNativeJournalSnapshots.isSnapshotId(resource.resourceId())) {
                throw JournalStoreRows.invalid("Native snapshot resources require fenced snapshot publication.");
            }
            JournalStoreRows.validateDigest(resource.digest(), "resource digest", false);
            if (resource.schemaVersion() < 1 || resource.byteLength() < 0) {
                throw JournalStoreRows.invalid("Resource version or length is invalid.");
            }
            int maxResourceBytes = ManagedSessionStoreModels.inlineResourceBytes(resource.kind());
            if (resource.byteLength() > maxResourceBytes
                    && !("managed-tool-outcome".equals(resource.kind())
                    && resource.bytesBase64() == null)) {
                throw new ManagedAgentException(501,
                        ManagedSessionStoreModels.ERROR_OSS_DISABLED,
                        "Resources larger than " + (maxResourceBytes / 1024) + " KiB require the disabled"
                                + " OSS storage path.");
            }
            byte[] bytes = resource.bytesBase64() == null ? null
                    : JournalStoreRows.decodeBase64(resource.bytesBase64(),
                            maxResourceBytes,
                            "resource bytesBase64");
            if (bytes != null && (bytes.length != resource.byteLength()
                    || !JournalStoreRows.sha256(bytes).equals(resource.digest()))) {
                throw JournalStoreRows.invalid("Resource bytes do not match their length or"
                        + " digest.");
            }
            if (bytes != null) {
                inlineBytes += bytes.length;
                if (inlineBytes
                        > ManagedSessionStoreModels.MAX_INLINE_TRANSACTION_BYTES) {
                    throw JournalStoreRows.payloadTooLarge("Inline resources exceed their"
                            + " transaction byte limit.");
                }
            }
            resources.add(new JournalResourceWrites.ValidatedResource(resource, bytes));
        }
        if (request.latestCheckpointResourceId() != null
                && resources.stream().map(JournalResourceWrites.ValidatedResource::resource)
                        .noneMatch(resource -> request
                                .latestCheckpointResourceId()
                                .equals(resource.resourceId())
                                && "managed-checkpoint"
                                        .equals(resource.kind()))) {
            throw JournalStoreRows.invalid("latestCheckpointResourceId must identify a"
                    + " managed-checkpoint resource in this transaction.");
        }
        return new ValidatedCommit(recordBytes, request.recordDigest(),
                resources);
    }

    void validateHead(JournalStoreRows.HeadRow head,
            CommitTransactionRequest request) {
        if (request.expectedJournalRevision() != head.journalRevision()
                || request.expectedCommittedSequence()
                        != head.committedSequence()
                || !Objects.equals(request.previousCommitDigest(),
                        head.lastCommitDigest())) {
            throw JournalStoreRows.conflict("managed_session_head_conflict",
                    "The Managed Session head changed; reload before"
                            + " retrying.");
        }
        if (request.activationEpoch() < head.activationEpoch()) {
            throw JournalStoreRows.conflict("managed_session_activation_conflict",
                    "The activation epoch is stale.");
        }
        if (!"READY".equals(head.recoveryStatus())) {
            throw JournalStoreRows.conflict("managed_session_recovery_blocked",
                    "The Managed Session is blocked from new commits.");
        }
        if ("session.create".equals(request.operation())) {
            if (head.journalRevision() != 0
                    || head.committedSequence() != 0) {
                throw JournalStoreRows.conflict("managed_session_head_conflict",
                        "The Managed Session genesis is already committed.");
            }
        } else if (head.journalRevision() == 0
                || request.firstSequence()
                        != JournalStoreRows.increment(head.committedSequence(),
                                "committed sequence")) {
            throw JournalStoreRows.conflict("managed_session_head_conflict",
                    "The transaction does not extend the committed"
                            + " sequence.");
        }
    }

    CommitReceipt replay(JournalStoreRows.TransactionRow existing,
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
                || !JournalFencing.secureEquals(existing.writerTokenHash(),
                        JournalFencing.tokenHash(writerToken))
                || existing.activationEpoch() != request.activationEpoch()
                || !Objects.equals(existing.latestCheckpointResourceId(),
                        request.latestCheckpointResourceId())
                || !Objects.equals(existing.commitDigest(),
                        request.commitDigest())) {
            throw JournalStoreRows.conflict(
                    ManagedSessionStoreModels.ERROR_IDEMPOTENCY_CONFLICT,
                    "The command key was reused with different content.");
        }
        return new CommitReceipt(existing.journalRevision(),
                existing.transactionId(), existing.commandId(),
                existing.operation(), existing.firstSequence(),
                existing.lastSequence(), existing.lastSequence(),
                existing.commitDigest(), true);
    }

    record ValidatedCommit(byte[] recordBytes, String recordDigest,
            List<JournalResourceWrites.ValidatedResource> resources) {
    }
}
