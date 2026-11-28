package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;

import java.util.List;
import java.util.Map;
import java.util.Set;

public interface HarnessPlacementStore {
    public static final String RELEASE_DOMAIN = "hosted_harness_release";

    public record Placement(String tenantId, String sessionId, String workspaceId,
            String instanceId, String bootId, long epoch, String state) {
    }

    public record Claim(Placement placement, long reservedUntil) {
    }

    public Placement get(String tenant, String session);

    public boolean hasUnreleasedOwnership(String instance, String boot);

    /** Finds expired clean suspensions whose owners are not protected from background reclamation. */
    public List<Placement> findExpiredSuspensions(Set<String> excludedInstanceIds, int limit);

    public Map<String, Object> releaseReceipt(String tenant, String session, long epoch, String operationId);

    public Placement assign(String tenant, String session, String instance, String boot);

    public Placement assignForLifecycle(OperationRecord operation, String instance, String boot);

    public boolean quiesce(String tenant, String session, Placement expected);

    public Placement takeover(String tenant, String session, Placement expected, String instance, String boot);

    public Placement takeoverForLifecycle(OperationRecord operation, Placement expected, String instance, String boot);

    /** Records claim demand once and returns its age in database milliseconds. */
    public long recordDemand(String tenant, String session);

    /** Takes over the placement for a poller and reserves the new placement for that poller alone. */
    public Claim claim(String tenant, String session, Placement expected, String instance, String boot);

    /** Placed Sessions with claim demand, no live reservation and no live writer, oldest demand first. */
    public List<Placement> findClaimCandidates(int limit);

    /** Live claims that this instance and boot have not yet consumed by acquiring a writer. */
    public List<Claim> findReservedClaims(String instance, String boot, int limit);

    public static String releaseId(long epoch) {
        return "placement:" + epoch;
    }
}
