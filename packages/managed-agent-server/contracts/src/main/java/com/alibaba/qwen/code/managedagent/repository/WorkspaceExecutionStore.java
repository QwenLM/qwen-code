package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

public interface WorkspaceExecutionStore {
    public java.nio.file.Path createdStorageRoot(String tenantId, String storageId);

    public boolean verifiedRecoveryEnabled();

    public void authorize(SessionRecord session);

    public void authorizeLifecycle(SessionRecord session, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority);

    public void authorizeLegacyClose(SessionRecord session);

    public void verifyMountForProbe(ContextBinding binding);

    public void authorizePassiveAttachment(SessionRecord session);

    public void authorizeCancellation(SessionRecord session);

    public void authorizeRecoveryCancellation(SessionRecord session,
            String turnId, String dispatchOwner);

    public void authorizeCommittedStop(SessionRecord session);

    public void authorizeActionResponse(SessionRecord session);

    public void claim(ContextBinding binding, RuntimeSessionRecord session);

    public boolean beginRewind(ContextBinding binding, RuntimeSessionRecord session);

    public void endRewind(ContextBinding binding, RuntimeSessionRecord session);

    public boolean hasExclusiveClaim(RuntimeSessionRecord session);

    public void assertHeld(ContextBinding binding, RuntimeSessionRecord session);

    public boolean isHeld(ContextBinding binding, RuntimeSessionRecord session);

    public void release(ContextBinding binding, RuntimeSessionRecord session);

    public String holdForMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration);

    public void releaseMaintenance(ContextBinding binding, String maintenanceId,
            long claimGeneration, String executionId);

    public int releaseStaleMaintenance(long now, long resumableGraceMillis);

    public boolean hasHolder(RuntimeBindingRecord saved);

    public boolean canStopDrained(RuntimeBindingRecord saved);

    public void releaseLost(RuntimeBindingRecord saved);

    public static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false);
    }

    public static RuntimeBrokerException unavailable(Throwable cause) {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false, cause);
    }

    public static RuntimeBrokerException unavailableTransient(
            Throwable cause) {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace mount cannot be verified right now.", true,
                cause);
    }

    public static RuntimeBrokerException unavailablePendingGrant() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace access grant or registry state is changing.", true);
    }
}
