package com.alibaba.qwen.code.managedagent.repository;

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
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

public interface ManagedSessionStore {
    public void authorizeLifecycle(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public void authorizeOrdinary(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request);

    public java.util.Map<String, Object> approvalSelection(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.AuthorizeLifecycleRequest request);

    public WriterGrant acquireWriter(String tenantId, String sessionId,
            String writerToken, AcquireWriterRequest request);

    public WriterGrant acquireWriter(String tenantId, String sessionId, String writerToken,
            AcquireWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public WriterGrant renewWriter(String tenantId, String sessionId,
            String writerToken, RenewWriterRequest request);

    public WriterGrant renewWriter(String tenantId, String sessionId, String writerToken,
            RenewWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public SealReceipt sealWriter(String tenantId, String sessionId,
            String writerToken, SealWriterRequest request);

    public SealReceipt sealWriter(String tenantId, String sessionId, String writerToken,
            SealWriterRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public void quiesceOwnership(String tenant, String session, String token,
            ManagedSessionStoreModels.QuiesceOwnershipRequest request);

    public JsonNode releaseOwnership(String tenantId, String sessionId, String writerToken,
            ManagedSessionStoreModels.ReleaseOwnershipRequest request);

    public RecoveryStateReceipt blockRecovery(String tenantId,
            String sessionId, String writerToken,
            BlockRecoveryRequest request);

    public CommitReceipt commit(String tenantId, String sessionId,
            String writerToken, CommitTransactionRequest request);

    public CommitReceipt commit(String tenantId, String sessionId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public RestoreHead restore(String tenantId, String workspaceId,
            String sessionId, String writerToken);

    public ManagedSessionStoreModels.RecentTransactionPage recentTransactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, Long beforeRevision, int limit);

    public ManagedSessionStoreModels.CommandTransaction commandTransaction(String tenantId, String workspaceId,
            String sessionId, String writerToken, Long throughRevision, String operation, String commandId);

    public TransactionPage transactions(String tenantId, String workspaceId,
            String sessionId, String writerToken, long afterRevision,
            int limit);

    public boolean hasPristineInitialJournal(String tenantId, String sessionId, String workspaceId);

    public StoredResource readResource(String tenantId, String workspaceId,
            String sessionId, String resourceId, String writerToken);

    public StoredResource readOwnerResource(
            String tenantId,
            String workspaceId,
            String sessionId,
            String resourceId,
            String writerToken);

    public ToolResultResourceRef publishAgentInstructions(String tenantId,
            String workspaceId, String sessionId, String instructions);

    public ToolResultResourceRef publishAgentSkills(String tenantId,
            String workspaceId, String sessionId, List<java.util.Map<String, Object>> skills);

    public ToolResultResourceRef publishInheritedExtensionResource(String tenantId, String workspaceId, String sessionId, StoredResource source);

    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request);

    public ToolResultResourceRef publishToolResult(String tenantId, String sessionId,
            String writerToken, PublishToolResultRequest request,
            com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public boolean hasLiveWriter(String tenantId, String sessionId);

    public static String sessionScopeKey(String tenantId, String sessionId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(tenantId, sessionId);
    }

    public static String resourceKey(String scopeKey, String resourceId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scopeKey, resourceId);
    }
}
