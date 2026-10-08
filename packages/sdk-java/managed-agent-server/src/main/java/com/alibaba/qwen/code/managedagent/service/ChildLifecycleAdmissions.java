package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * H4b: the idempotent admission of a child Session's own lifecycle close.
 * The close cascade admits under a stable key re-derived from the child
 * run, so a contested admission replays its receipt instead of minting a
 * second operation, and a finished child (relay `done`) closes through the
 * exact same admission its parent's close would have taken. The child
 * actor clones the parent's creation actor shape, matching how
 * createChildSession registered it.
 */
@Component
public class ChildLifecycleAdmissions {
    private final AgentStateStore store;
    private final RequestDigests digests;
    private final RuntimeWarmer runtimeWarmer;

    public ChildLifecycleAdmissions(AgentStateStore store,
            RequestDigests digests, RuntimeWarmer runtimeWarmer) {
        this.store = store;
        this.digests = digests;
        this.runtimeWarmer = runtimeWarmer;
    }

    /** Whether this host can close a Workspace Session at all. Without it
     * no close is ever admitted, so a caller must not hold anything else
     * (a parent's settlement) hostage to one. */
    public boolean closeSupported() {
        return runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose();
    }

    /** Admits the child Session's idempotent close, or replays the
     * admission already in flight under this key. The caller's duty is
     * only to dispatch; an active Turn or an unavailable Runtime lane
     * throws so the close re-arms instead of settling on suspicion. */
    public OperationAdmission admitChildClose(String tenantId,
            String parentSessionId, String childSessionId,
            String childRunId) {
        String actor = "child:" + parentSessionId;
        return store.beginWorkspaceLifecycle(tenantId, childSessionId,
                OperationKind.CLOSE, actor,
                digests.digest(Map.of("actorId", actor)),
                "child-close-" + childRunId,
                digests.digest(Map.of("sessionId", childSessionId,
                        "operation", "CLOSE_SESSION")),
                runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose());
    }
}
