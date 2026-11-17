package com.alibaba.qwen.code.managedagent.harness.contracts;

import java.util.List;

public record HarnessCapabilities(int currentProtocolVersion, List<Integer> supportedProtocolVersions, String bootId, String instanceId, String capabilityDigest, int lifecycleProtocolVersion, List<String> features, int titleProtocolVersion, List<String> lifecycleV2Profiles) {
    public int getCurrentProtocolVersion() { return currentProtocolVersion; }
    public List<Integer> getSupportedProtocolVersions() { return supportedProtocolVersions; }
    public String getBootId() { return bootId; }
    public String getInstanceId() { return instanceId; }
    public String getCapabilityDigest() { return capabilityDigest; }
    public int getLifecycleProtocolVersion() { return lifecycleProtocolVersion; }
    public List<String> getFeatures() { return features; }
    public int getTitleProtocolVersion() { return titleProtocolVersion; }
    public List<String> getLifecycleV2Profiles() { return lifecycleV2Profiles; }
}
