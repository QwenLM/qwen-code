package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.TransactionPage;
import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.*;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;

public interface ManagedSideQueries {
    Context context(String tenant, String actor, String session);
    Admission admit(String tenant, String actor, String session, Create request, boolean generationAvailable);
    Query get(String tenant, String actor, String session, String queryId);
    Page list(String tenant, String actor, String session, String cursor, int limit);
    Query cancel(String tenant, String actor, String session, String queryId);
    Claim claim(String tenant, String session, String queryId, String instanceId, String bootId);
    FrozenInput frozen(String tenant, String session, String queryId, Claim claim);
    TransactionPage transactions(String tenant, String session, String queryId, Claim claim,
            long afterRevision, int limit);
    StoredResource resource(String tenant, String session, String queryId, Claim claim, String resourceId);
    SessionModelConfig modelConfig(String tenant, String session, String queryId, Claim claim);
    void stage(String tenant, String session, String queryId, Claim claim, CommitResource resource);
    Query publishInput(String tenant, String session, String queryId, Claim claim, InputPublication input);
    boolean start(String tenant, String session, String queryId, Claim claim);
    boolean active(String tenant, String session, String queryId, Claim claim);
    Query snapshot(String tenant, String session, String queryId, Claim claim, ResultUpdate result);
    Query interrupt(String tenant, String session, String queryId, String reason);
    int reconcileExpired();
}
