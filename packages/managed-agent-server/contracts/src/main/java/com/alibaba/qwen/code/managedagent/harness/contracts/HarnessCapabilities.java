package com.alibaba.qwen.code.managedagent.harness.contracts;

public record HarnessCapabilities(int currentProtocolVersion, java.util.List<Integer> supportedProtocolVersions, String bootId, String instanceId, String capabilityDigest, int lifecycleProtocolVersion, java.util.List<String> features, int titleProtocolVersion, java.util.List<String> lifecycleV2Profiles) {
    public int getCurrentProtocolVersion() { return currentProtocolVersion; }
    public java.util.List<Integer> getSupportedProtocolVersions() { return supportedProtocolVersions; }
    public String getBootId() { return bootId; }
    public String getInstanceId() { return instanceId; }
    public String getCapabilityDigest() { return capabilityDigest; }
    public int getLifecycleProtocolVersion() { return lifecycleProtocolVersion; }
    public java.util.List<String> getFeatures() { return features; }
    public int getTitleProtocolVersion() { return titleProtocolVersion; }
    public java.util.List<String> getLifecycleV2Profiles() { return lifecycleV2Profiles; }
}
