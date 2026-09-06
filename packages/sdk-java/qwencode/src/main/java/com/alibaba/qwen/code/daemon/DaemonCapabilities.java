package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Validated capabilities returned by {@code GET /capabilities}. */
public final class DaemonCapabilities {
    private final int version;
    private final String mode;
    private final List<String> features;
    private final List<String> transports;
    private final String workspaceCwd;
    private final String qwenCodeVersion;
    private final Map<String, Object> raw;

    DaemonCapabilities(int version, String mode, List<String> features,
            List<String> transports, String workspaceCwd,
            String qwenCodeVersion, Map<String, Object> raw) {
        this.version = version;
        this.mode = mode;
        this.features = Collections.unmodifiableList(features);
        this.transports = Collections.unmodifiableList(transports);
        this.workspaceCwd = workspaceCwd;
        this.qwenCodeVersion = qwenCodeVersion;
        this.raw = Collections.unmodifiableMap(raw);
    }

    public int getVersion() {
        return version;
    }

    public String getMode() {
        return mode;
    }

    public List<String> getFeatures() {
        return features;
    }

    public List<String> getTransports() {
        return transports;
    }

    public String getWorkspaceCwd() {
        return workspaceCwd;
    }

    public String getQwenCodeVersion() {
        return qwenCodeVersion;
    }

    public Map<String, Object> getRaw() {
        return raw;
    }

    public boolean supports(String feature) {
        return features.contains(feature);
    }
}
