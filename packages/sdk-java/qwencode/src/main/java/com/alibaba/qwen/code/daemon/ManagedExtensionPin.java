package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/** Immutable published extension revision. Reuse a pin returned by a published package when possible. */
public final class ManagedExtensionPin extends ManagedJson {
    public ManagedExtensionPin(String extensionId, long packageRevision, String packageDigest) {
        this(extensionId, packageRevision, packageDigest, null);
    }

    public ManagedExtensionPin(String extensionId, long packageRevision, String packageDigest, Long settingsRevision) {
        this(fields(extensionId, packageRevision, packageDigest, settingsRevision));
    }

    ManagedExtensionPin(Map<String, Object> json) {
        super(json);
    }

    public String getExtensionId() {
        return string("extensionId");
    }

    public long getPackageRevision() {
        return number("packageRevision");
    }

    public String getPackageDigest() {
        return string("packageDigest");
    }

    public Long getSettingsRevision() {
        return optionalNumber("settingsRevision");
    }

    /** Selects an immutable settings revision for this package. */
    public ManagedExtensionPin withSettingsRevision(long settingsRevision) {
        return new ManagedExtensionPin(getExtensionId(), getPackageRevision(), getPackageDigest(), settingsRevision);
    }

    private static Map<String, Object> fields(String extensionId, long revision, String digest, Long settingsRevision) {
        Map<String, Object> json = new LinkedHashMap<>(Map.of(
                "extensionId", extensionId, "packageRevision", revision, "packageDigest", digest));
        put(json, "settingsRevision", settingsRevision);
        return Map.copyOf(json);
    }
}
