package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.ArrayList;
import java.util.List;

/** Negotiated private protocol contract for one Hosted Harness process. */
public final class HostedHarnessCapabilities {
    private final int currentProtocolVersion;
    private final List<Integer> supportedProtocolVersions;
    private final String bootId;
    private final String capabilityDigest;
    private final int lifecycleProtocolVersion;
    private final List<String> features;

    public List<String> getFeatures() { return features; }

    public int getLifecycleProtocolVersion() { return lifecycleProtocolVersion; }

    HostedHarnessCapabilities(int currentProtocolVersion,
            List<Integer> supportedProtocolVersions, String bootId,
            String capabilityDigest) {
        this(currentProtocolVersion, supportedProtocolVersions, bootId, capabilityDigest, 0);
    }

    HostedHarnessCapabilities(int currentProtocolVersion, List<Integer> supportedProtocolVersions,
            String bootId, String capabilityDigest, int lifecycleProtocolVersion) {
        this(currentProtocolVersion, supportedProtocolVersions, bootId, capabilityDigest, lifecycleProtocolVersion, List.of());
    }

    HostedHarnessCapabilities(int currentProtocolVersion, List<Integer> supportedProtocolVersions,
            String bootId, String capabilityDigest, int lifecycleProtocolVersion, List<String> features) {
        this.features = List.copyOf(features);
        this.lifecycleProtocolVersion = lifecycleProtocolVersion;
        this.currentProtocolVersion = currentProtocolVersion;
        this.supportedProtocolVersions = Collections.unmodifiableList(
                new ArrayList<>(supportedProtocolVersions));
        this.bootId = bootId;
        this.capabilityDigest = capabilityDigest;
    }

    public int getCurrentProtocolVersion() {
        return currentProtocolVersion;
    }

    public List<Integer> getSupportedProtocolVersions() {
        return supportedProtocolVersions;
    }

    public String getBootId() {
        return bootId;
    }

    public String getCapabilityDigest() {
        return capabilityDigest;
    }
}
