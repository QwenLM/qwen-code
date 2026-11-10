package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.PublishToolResultRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RecoveryStateReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealReceipt;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.sql.SQLException;
import java.util.List;
import java.util.function.Supplier;

@Repository
@Qualifier("managedAgentTransactionManager")
public class JdbcManagedSessionStore
        implements ManagedSessionStore {
    private final JdbcTemplate jdbc;
    private final JournalStoreRows storeRows;
    private final JournalFencing fencing;
    private final JournalHistoryQueries historyQueries;
    private final JournalLifecycleAuthorization lifecycleAuthorization;
    private final JournalResourceReads resourceReads;
    private final JournalResourceWrites resourceWrites;
    private final JournalWriterLifecycle writerLifecycle;
    private final JournalCommit commits;
    private final org.springframework.transaction.support.TransactionTemplate writerTransactions;
    private final org.springframework.transaction.support.TransactionTemplate readTransactions;
    private SessionObjectResources objectResources;
    private com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess journalAccess;

    @Autowired(required = false)
    public void configureJournalAccess(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess access) {
        this.journalAccess = access;
    }

    private <T> T journalRead(String tenant, String workspace, String session, String token, Supplier<T> action) {
        fencing.requireCredential(tenant, workspace, session, token);
        var head = storeRows.requireHead(tenant, session);
        storeRows.requireHeadScope(head, tenant, workspace, session);
        fencing.requireReadGrant(head, token);
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return JournalResidencyGuard.read(jdbc, null, tenant, session, action);
        }
        Supplier<T> read = () -> objectResources == null ? readTransactions.execute(status -> action.get())
                : objectResources.readTransaction(tenant, session, readTransactions, action);
        return journalAccess == null ? read.get() : journalAccess.read(tenant, session, read);
    }

    public void installObjectResources(SessionObjectResources resources) {
        this.objectResources = resources;
        this.resourceReads.installResourceBodies(resources.bodies());
    }

    private WriterGrant withResourceCapability(String tenant, String session, WriterGrant grant) {
        return new WriterGrant(grant.writerGeneration(), grant.leaseUntil(), grant.journalRevision(), grant.committedSequence(),
                grant.lastCommitDigest(), grant.activationEpoch(), grant.replayed(), grant.supportedStorageVersion(),
                grant.activationLeaseRenewal(), grant.activationLease(), objectResources != null && objectResources.writesEnabled()
                        && grant.supportedStorageVersion() >= 6
                        && jdbc.queryForObject("SELECT CASE WHEN is_csi_guard = FALSE OR tool_profile = 'csi-files-retirement/4' THEN 1 ELSE 0 END FROM ma_session WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session) == 1);
    }

    public JdbcManagedSessionStore(JdbcTemplate jdbc) {
        this(jdbc, new JdbcManagedExtensionRecordStore(jdbc));
    }

    public JdbcManagedSessionStore(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore extensionRecords) {
        this(jdbc, extensionRecords, null);
    }

    public JdbcManagedSessionStore(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore extensionRecords,
            JdbcManagedActionStore actions) {
        this(jdbc, extensionRecords, actions, null,
                com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy.inProcess(),
                null, null, null, null, null, WriterCredentialPolicy.unbound(), null);
    }

    @Autowired
    public JdbcManagedSessionStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            JdbcManagedExtensionRecordStore extensionRecords, JdbcManagedActionStore actions,
            com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules,
            com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion,
            @org.springframework.lang.Nullable JdbcWorkspaceExecutionStore lifecycleExecution,
            @org.springframework.lang.Nullable SessionQueryStore lifecycleSessions,
            @org.springframework.lang.Nullable ToolPublicationObjectStore publicationObjects,
            @org.springframework.lang.Nullable JdbcManagedToolResultStore toolResults,
            @org.springframework.lang.Nullable JournalEventTransport journalEventTransport,
            WriterCredentialPolicy credentials,
            @org.springframework.lang.Nullable RuntimeBindingRepository bindings) {
        this.jdbc = jdbc;
        if (lifecycleExecution == null || lifecycleSessions == null) {
            lifecycleExecution = null;
            lifecycleSessions = null;
        }
        JdbcRuntimeBindingRepository csiBindings =
                bindings instanceof JdbcRuntimeBindingRepository original
                                && original.usesDataSource(jdbc.getDataSource())
                        ? original
                        : null;
        var manager = new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource());
        this.writerTransactions = new org.springframework.transaction.support.TransactionTemplate(manager);
        this.writerTransactions.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.writerTransactions.setTimeout(30);
        this.readTransactions = new org.springframework.transaction.support.TransactionTemplate(manager);
        this.readTransactions.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.readTransactions.setReadOnly(true);
        this.readTransactions.setTimeout(30);
        ToolPublicationRetentionStore outputRetention = new ToolPublicationRetentionStore(jdbc, manager);
        var ownerReads = new org.springframework.transaction.support.TransactionTemplate(manager);
        ownerReads.setTimeout(10);
        this.storeRows = new JournalStoreRows(readerVersion, jdbc);
        this.fencing = new JournalFencing(storeRows, jdbc, journalEventTransport, credentials, csiBindings);
        this.historyQueries = new JournalHistoryQueries(fencing, storeRows, jdbc);
        this.lifecycleAuthorization = new JournalLifecycleAuthorization(fencing, storeRows, harnessRules, jdbc, extensionRecords, lifecycleExecution, lifecycleSessions);
        this.resourceReads = new JournalResourceReads(fencing, storeRows, jdbc, publicationObjects, outputRetention, ownerReads);
        this.resourceWrites = new JournalResourceWrites(fencing, storeRows, jdbc);
        this.writerLifecycle = new JournalWriterLifecycle(fencing, storeRows, readerVersion, jdbc, credentials, csiBindings, extensionRecords);
        this.commits = new JournalCommit(fencing, lifecycleAuthorization, resourceWrites, storeRows, readerVersion, jdbc, toolResults, journalEventTransport, extensionRecords, actions);
    }

    static final int GUARD_ACQUIRE_TIMEOUT_SECONDS = JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS;

    @Transactional
    public void authorizeLifecycle(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        lifecycleAuthorization.authorizeLifecycle(tenantId, sessionId, writerToken, request, authority);
    }

    static <T> T skipContended(
            org.springframework.transaction.support.TransactionTemplate transactions,
            org.springframework.transaction.support.TransactionCallback<T> body) {
        return JournalFencing.skipContended(transactions, body);
    }

    static void lockBounded(Runnable lock) {
        JournalFencing.lockBounded(lock);
    }

    static <T> T lockBoundedResult(Supplier<T> lock) {
        return JournalFencing.lockBoundedResult(lock);
    }

    static <T> T namedRootDeadlock(Supplier<T> lock) {
        return JournalFencing.namedRootDeadlock(lock);
    }

    @Transactional
    public void authorizeOrdinary(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        lifecycleAuthorization.authorizeOrdinary(tenantId, sessionId, writerToken, request);
    }

    void authorizeObjectWriter(String tenant, String session, String token,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_csi_guard FROM ma_session WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session))) {
            if (authority == null) {
                lifecycleAuthorization.authorizeOrdinary(tenant, session, token, request);
            } else {
                lifecycleAuthorization.authorizeLifecycle(tenant, session, token, request, authority);
            }
            return;
        }
        JournalStoreRows.validateScope(tenant, request.workspaceId(), session);
        fencing.requireCredential(tenant, request.workspaceId(), session, token);
        var root = fencing.lockSessionFirst(tenant, session);
        fencing.requirePlacement(tenant, request.workspaceId(), session, token, request.writerId(), false);
        var continuation = fencing.lockCsiContinuation(tenant, session, root);
        var original = continuation == null ? null : continuation.original();
        if (original == null || !com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile.supportsStorage(original.request().getScope(), 6)) {
            throw JournalStoreRows.conflict("managed_session_reader_version_unsupported", "This CSI profile does not admit external Session resources.");
        }
        original.requireContinuation();
        var head = fencing.requireHeadAfterCsiCheck(tenant, session);
        storeRows.requireHeadScope(head, tenant, request.workspaceId(), session);
        fencing.requireNoLifecycleClaim(tenant, session);
        JournalFencing.requireCsiWriter(original, head);
        fencing.requireWriter(head, request.writerId(), request.writerGeneration(), token, storeRows.databaseNow(), true);
        fencing.requireInstalledCsiWriter(original);
        fencing.requireCsiWriterCurrent(continuation, head, request.writerId(), request.writerGeneration(), token);
    }

    @Transactional
    public java.util.Map<String, Object> approvalSelection(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        return lifecycleAuthorization.approvalSelection(tenantId, sessionId, writerToken, request);
    }

    boolean usesDataSource(javax.sql.DataSource source) {
        return storeRows.usesDataSource(source);
    }

    <T> T resourceTransaction(String tenant, String session, org.springframework.transaction.support.TransactionTemplate transaction, Supplier<T> sql) {
        return objectResources == null ? transaction.execute(status -> sql.get()) : objectResources.readTransaction(tenant, session, transaction, sql);
    }

    <T> T journalData(String tenant, String session, Supplier<T> action) {
        return JournalResidencyGuard.read(jdbc, journalAccess, tenant, session, action);
    }

    <T> T protectedResources(Supplier<T> action, Runnable authorize) {
        return objectResources == null ? action.get() : objectResources.protectedResources(action, authorize);
    }

    record PublicationWriter(long now, long leaseUntil, long journalRevision,
            long committedSequence, long activationEpoch, String checkpointId, String recoveryStatus,
            String activationId, String activationPhase, Long activationEventEpoch,
            Long activationExpiresAt, Long activationHeadRevision) {
    }

    RestoreHead lockSnapshotWriter(String tenant, String session, String token,
            ManagedNativeJournalSnapshots.PublishRequest request) {
        return writerLifecycle.lockSnapshotWriter(tenant, session, token, request);
    }

    PublicationWriter lockPublicationWriter(String tenant, String workspace,
            String session, String writer, long generation, String token) {
        return writerLifecycle.lockPublicationWriter(tenant, workspace, session, writer, generation, token);
    }

    /**
     * As above; {@code placement} and {@code publicationGuard} false skip those tenant guards, for a lane
     * that did not take them before the Session root (ordinary publication lanes).
     */
    PublicationWriter lockPublicationWriter(String tenant, String workspace, String session, String writer,
            long generation, String token, boolean placement, boolean publicationGuard) {
        return writerLifecycle.lockPublicationWriter(tenant, workspace, session, writer, generation, token,
                placement, publicationGuard);
    }

    public WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request) {
        return acquireWriter(tenantId, sessionId, writerToken, request, null);
    }

    public WriterGrant acquireWriter(String tenantId, String sessionId, String writerToken,
            AcquireWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        JournalStoreRows.validateScope(tenantId, request.workspaceId(), sessionId);
        fencing.requireCredential(tenantId, request.workspaceId(), sessionId, writerToken);
        if (journalAccess != null) {
            if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
                JournalResidencyGuard.requireHot(jdbc, tenantId, sessionId);
            } else {
                journalAccess.ensureHot(tenantId, sessionId);
            }
        }
        for (;;) {
            WriterGrant grant = objectResources == null
                    ? writerTransactions.execute(status -> writerLifecycle.acquireWriter(tenantId, sessionId, writerToken, request, authority))
                    : objectResources.readTransaction(tenantId, sessionId, writerTransactions,
                            () -> writerLifecycle.acquireWriter(tenantId, sessionId, writerToken, request, authority));
            if (grant != null) {
                return withResourceCapability(tenantId, sessionId, grant);
            }
        }
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request) {
        return withResourceCapability(tenantId, sessionId, writerLifecycle.renewWriter(tenantId, sessionId, writerToken, request, null));
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId, String writerToken,
            RenewWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return withResourceCapability(tenantId, sessionId, writerLifecycle.renewWriter(tenantId, sessionId, writerToken, request, authority));
    }

    @Transactional
    public SealReceipt sealWriter(String tenantId, String sessionId,
            String writerToken, SealWriterRequest request) {
        return writerLifecycle.sealWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public SealReceipt sealWriter(String tenantId, String sessionId, String writerToken,
            SealWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return writerLifecycle.sealWriter(tenantId, sessionId, writerToken, request, authority);
    }

    @Transactional
    public void quiesceOwnership(String tenant, String session, String token,
            ManagedSessionStoreModels.QuiesceOwnershipRequest request) {
        writerLifecycle.quiesceOwnership(tenant, session, token, request);
    }

    @Transactional
    public JsonNode releaseOwnership(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.ReleaseOwnershipRequest request) {
        return writerLifecycle.releaseOwnership(tenantId, sessionId, writerToken, request);
    }

    @Transactional
    public RecoveryStateReceipt blockRecovery(String tenantId,
            String sessionId, String writerToken,
            BlockRecoveryRequest request) {
        return writerLifecycle.blockRecovery(tenantId, sessionId, writerToken, request);
    }

    public CommitReceipt commit(String tenantId, String sessionId,
            String writerToken, CommitTransactionRequest request) {
        return commit(tenantId, sessionId, writerToken, request, null);
    }

    public CommitReceipt commit(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return objectResources == null
                ? writerTransactions.execute(status -> commits.commit(tenantId, sessionId, writerToken, request, authority))
                : objectResources.commit(tenantId, sessionId, writerToken, request, authority,
                        () -> commits.commit(tenantId, sessionId, writerToken, request, authority));
    }

    public RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        return journalRead(tenantId, workspaceId, sessionId, writerToken, () -> historyQueries.restore(tenantId, workspaceId, sessionId, writerToken));
    }

    public TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit) {
        return journalRead(tenantId, workspaceId, sessionId, writerToken, () -> historyQueries.transactions(tenantId, workspaceId, sessionId, writerToken, afterRevision, limit));
    }

    public ManagedSessionStoreModels.RecentTransactionPage recentTransactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, Long beforeRevision, int limit) {
        return journalRead(tenantId, workspaceId, sessionId, writerToken, () -> historyQueries.recentTransactions(tenantId, workspaceId, sessionId, writerToken, throughRevision, beforeRevision, limit));
    }

    public ManagedSessionStoreModels.CommandTransaction commandTransaction(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, String operation, String commandId) {
        return journalRead(tenantId, workspaceId, sessionId, writerToken, () -> historyQueries.commandTransaction(tenantId, workspaceId, sessionId, writerToken, throughRevision, operation, commandId));
    }

    public boolean hasPristineInitialJournal(String tenantId, String sessionId, String workspaceId) {
        return JournalResidencyGuard.read(jdbc, journalAccess, tenantId, sessionId,
                () -> resourceTransaction(tenantId, sessionId, readTransactions, () -> historyQueries.hasPristineInitialJournal(tenantId, sessionId, workspaceId)));
    }

    public StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken) {
        return resourceReads.readResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
    }

    StoredResource readSnapshotResource(String tenantId, String workspaceId, String sessionId,
            String resourceId, String writerToken) {
        return resourceReads.readSnapshotResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
    }

    public StoredResource readOwnerResource(
            String tenantId,
            String workspaceId,
            String sessionId,
            String resourceId,
            String writerToken) {
        return resourceReads.readOwnerResource(tenantId, workspaceId, sessionId, resourceId, writerToken);
    }

    @Transactional
    public ToolResultResourceRef publishAgentInstructions(String tenantId,
            String workspaceId, String sessionId, String instructions) {
        return resourceWrites.publishAgentInstructions(tenantId, workspaceId, sessionId, instructions);
    }

    public ToolResultResourceRef publishAgentSkills(String tenantId,
            String workspaceId, String sessionId, List<java.util.Map<String, Object>> skills) {
        byte[] bytes = com.alibaba.qwen.code.managedagent.contracts.catalog.AgentDefinitionExtensions.skillsBytes(skills);
        if (objectResources != null && objectResources.externalPublication(tenantId, sessionId, "agent-skills-" + JournalStoreRows.sha256(bytes), bytes.length)) {
            return objectResources.publishConfiguration(tenantId, workspaceId, sessionId, "managed-agent-skills", "agent-skills-" + JournalStoreRows.sha256(bytes), bytes);
        }
        return writerTransactions.execute(status -> resourceWrites.publishAgentSkills(tenantId, workspaceId, sessionId, skills));
    }

    @Transactional
    public ToolResultResourceRef publishInheritedExtensionResource(String tenantId, String workspaceId, String sessionId, StoredResource source) {
        return resourceWrites.publishInheritedExtensionResource(tenantId, workspaceId, sessionId, source);
    }

    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request) {
        return publishToolResult(tenantId, sessionId, writerToken, request, null);
    }

    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        if (objectResources != null && objectResources.externalPublication(tenantId, sessionId, request.resourceId(), request.byteLength())) {
            writerTransactions.executeWithoutResult(status -> resourceWrites.publishToolResult(tenantId, sessionId, writerToken, request, authority, true));
            var allocated = objectResources.allocate(tenantId, sessionId, writerToken,
                    new ManagedSessionStoreModels.AllocateResourceRequest(request.workspaceId(), request.writerId(), request.writerGeneration(), request.resourceId(), request.kind(), request.schemaVersion(), request.byteLength(), request.digest()), authority);
            objectResources.upload(tenantId, sessionId, request.resourceId(), allocated.uploadId(), writerToken,
                    new java.io.ByteArrayInputStream(JournalStoreRows.decodeBase64(request.bytesBase64(), JournalStoreRows.toolResultLimit(request.kind()), "resource bytesBase64")), authority);
        }
        return writerTransactions.execute(status -> resourceWrites.publishToolResult(tenantId, sessionId, writerToken, request, authority));
    }

    static int toolResultLimit(String kind) {
        return JournalStoreRows.toolResultLimit(kind);
    }

    record TerminalCandidate(CommitTransactionRequest request,
            com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.TerminalProof proof, String writerTokenSha256) {
    }

    void requireCsiApplicationCredential(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken) throws SQLException {
        fencing.requireCsiApplicationCredential(target, authority, writerToken);
    }

    void requireCsiHistoricalCredential(String tenant, String workspace, String session, String token, String retainedHash) {
        fencing.requireCsiHistoricalCredential(tenant, workspace, session, token, retainedHash);
    }

    TerminalCandidate preflightCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        return commits.preflightCsiTerminal(target, authority, writerToken, exactBody, bindings);
    }

    String commitCsiTerminal(java.sql.Connection target,
            com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority authority,
            String writerToken, byte[] exactBody, JdbcRuntimeBindingRepository bindings) throws SQLException {
        return commits.commitCsiTerminal(target, authority, writerToken, exactBody, bindings);
    }

    static CommitTransactionRequest validateCsiTerminalBytes(byte[] bytes) {
        return JournalCommit.validateCsiTerminalBytes(bytes);
    }

    JdbcCsiFilesRetirementGuard.Original lockCsiOriginal(String tenantId, String sessionId) {
        return fencing.lockCsiOriginal(tenantId, sessionId);
    }

    @Transactional
    public boolean hasLiveWriter(String tenantId, String sessionId) {
        return writerLifecycle.hasLiveWriter(tenantId, sessionId);
    }

    static String commandKeyHash(String operation,
            String commandId) {
        return JournalStoreRows.commandKeyHash(operation, commandId);
    }

    static ManagedAgentException journalCorrupt() {
        return JournalStoreRows.journalCorrupt();
    }
}
