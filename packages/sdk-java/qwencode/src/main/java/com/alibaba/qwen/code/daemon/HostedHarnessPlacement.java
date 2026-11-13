package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** The control plane's durable assignment of one Session to a process incarnation. */
public final class HostedHarnessPlacement {
    private final String instanceId;
    private final String bootId;
    private final long placementEpoch;

    public HostedHarnessPlacement(String instanceId, String bootId, long placementEpoch) {
        if (instanceId == null || !instanceId.matches("[A-Za-z0-9._:-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Harness instance identity");
        }
        this.instanceId = instanceId;
        this.bootId = HostedHarnessClient.requireUuid(bootId, "bootId");
        if (placementEpoch < 1 || placementEpoch > 9_007_199_254_740_991L) {
            throw new IllegalArgumentException("Invalid Harness placement epoch");
        }
        this.placementEpoch = placementEpoch;
    }

    public String getInstanceId() {
        return instanceId;
    }

    public String getBootId() {
        return bootId;
    }

    public long getPlacementEpoch() {
        return placementEpoch;
    }

    Map<String, Object> toJson() {
        return Map.of("instanceId", instanceId, "bootId", bootId, "placementEpoch", placementEpoch);
    }
}
