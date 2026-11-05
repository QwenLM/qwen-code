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
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.SQLException;
import java.util.List;
import java.util.function.Supplier;

@Repository
@Qualifier("managedAgentTransactionManager")
public class ManagedSessionStore
        implements com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore {
    private final JournalStoreRows storeRows;
    private final JournalFencing fencing;
    private final JournalHistoryQueries historyQueries;
    private final JournalLifecycleAuthorization lifecycleAuthorization;
    private final JournalResourceReads resourceReads;
    private final JournalResourceWrites resourceWrites;
    private final JournalWriterLifecycle writerLifecycle;
    private final JournalCommit commits;

    public ManagedSessionStore(JdbcTemplate jdbc) {
        this(jdbc, new ManagedExtensionRecordStore(jdbc));
    }

    public ManagedSessionStore(JdbcTemplate jdbc, ManagedExtensionRecordStore extensionRecords) {
        this(jdbc, extensionRecords, null);
    }

    public ManagedSessionStore(JdbcTemplate jdbc, ManagedExtensionRecordStore extensionRecords,
            ManagedActionStore actions) {
        this(jdbc, extensionRecords, actions, null,
                com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy.inProcess(),
                null, null, null, null, null, WriterCredentialPolicy.unbound(), null);
    }

    @Autowired
    public ManagedSessionStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            ManagedExtensionRecordStore extensionRecords, ManagedActionStore actions,
            com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules,
            com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy readerVersion,
            @org.springframework.lang.Nullable WorkspaceExecutionStore lifecycleExecution,
            @org.springframework.lang.Nullable SessionQueryStore lifecycleSessions,
            @org.springframework.lang.Nullable ToolPublicationObjectStore publicationObjects,
            @org.springframework.lang.Nullable ManagedToolResultStore toolResults,
            @org.springframework.lang.Nullable JournalEventTransport journalEventTransport,
            WriterCredentialPolicy credentials,
            @org.springframework.lang.Nullable RuntimeBindingRepository bindings) {
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
        ToolPublicationRetentionStore outputRetention = new ToolPublicationRetentionStore(jdbc, manager);
        var ownerReads = new org.springframework.transaction.support.TransactionTemplate(manager);
        ownerReads.setTimeout(10);
        this.storeRows = new JournalStoreRows(readerVersion, jdbc);
        this.fencing = new JournalFencing(storeRows, jdbc, journalEventTransport, credentials, csiBindings);
        this.historyQueries = new JournalHistoryQueries(fencing, storeRows, jdbc);
        this.lifecycleAuthorization = new JournalLifecycleAuthorization(fencing, storeRows, harnessRules, jdbc, extensionRecords, lifecycleExecution, lifecycleSessions);
        this.resourceReads = new JournalResourceReads(fencing, storeRows, jdbc, publicationObjects, outputRetention, ownerReads);
        this.resourceWrites = new JournalResourceWrites(fencing, storeRows, jdbc);
        this.writerLifecycle = new JournalWriterLifecycle(fencing, storeRows, readerVersion, jdbc, credentials, csiBindings);
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

    @Transactional
    public java.util.Map<String, Object> approvalSelection(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request) {
        return lifecycleAuthorization.approvalSelection(tenantId, sessionId, writerToken, request);
    }

    boolean usesDataSource(javax.sql.DataSource source) {
        return storeRows.usesDataSource(source);
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

    @Transactional
    public WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request) {
        return writerLifecycle.acquireWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public WriterGrant acquireWriter(String tenantId, String sessionId, String writerToken,
            AcquireWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return writerLifecycle.acquireWriter(tenantId, sessionId, writerToken, request, authority);
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request) {
        return writerLifecycle.renewWriter(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public WriterGrant renewWriter(String tenantId, String sessionId, String writerToken,
            RenewWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return writerLifecycle.renewWriter(tenantId, sessionId, writerToken, request, authority);
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

    @Transactional
    public CommitReceipt commit(String tenantId, String sessionId,
            String writerToken, CommitTransactionRequest request) {
        return commits.commit(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public CommitReceipt commit(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return commits.commit(tenantId, sessionId, writerToken, request, authority);
    }

    CommitReceipt commitPublicationReceipt(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request) {
        return commits.commitPublicationReceipt(tenantId, sessionId, writerToken, request);
    }

    @Transactional(readOnly = true)
    public RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken) {
        return historyQueries.restore(tenantId, workspaceId, sessionId, writerToken);
    }

    @Transactional(readOnly = true)
    public TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit) {
        return historyQueries.transactions(tenantId, workspaceId, sessionId, writerToken, afterRevision, limit);
    }

    @Transactional(readOnly = true, isolation = org.springframework.transaction.annotation.Isolation.READ_COMMITTED)
    public ManagedSessionStoreModels.RecentTransactionPage recentTransactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, Long beforeRevision, int limit) {
        return historyQueries.recentTransactions(tenantId, workspaceId, sessionId, writerToken, throughRevision, beforeRevision, limit);
    }

    @Transactional(readOnly = true, isolation = org.springframework.transaction.annotation.Isolation.READ_COMMITTED)
    public ManagedSessionStoreModels.CommandTransaction commandTransaction(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, String operation, String commandId) {
        return historyQueries.commandTransaction(tenantId, workspaceId, sessionId, writerToken, throughRevision, operation, commandId);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED, readOnly = true)
    public boolean hasPristineInitialJournal(String tenantId, String sessionId, String workspaceId) {
        return historyQueries.hasPristineInitialJournal(tenantId, sessionId, workspaceId);
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

    @Transactional
    public ToolResultResourceRef publishAgentSkills(String tenantId,
            String workspaceId, String sessionId, List<java.util.Map<String, Object>> skills) {
        return resourceWrites.publishAgentSkills(tenantId, workspaceId, sessionId, skills);
    }

    @Transactional
    public ToolResultResourceRef publishInheritedExtensionResource(String tenantId, String workspaceId, String sessionId, StoredResource source) {
        return resourceWrites.publishInheritedExtensionResource(tenantId, workspaceId, sessionId, source);
    }

    @Transactional
    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request) {
        return resourceWrites.publishToolResult(tenantId, sessionId, writerToken, request, null);
    }

    @Transactional
    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        return resourceWrites.publishToolResult(tenantId, sessionId, writerToken, request, authority);
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
