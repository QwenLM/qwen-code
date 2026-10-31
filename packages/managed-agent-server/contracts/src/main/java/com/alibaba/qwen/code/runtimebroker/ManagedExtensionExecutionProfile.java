package com.alibaba.qwen.code.runtimebroker;

import java.nio.file.Path;
import java.util.Map;

/** Explicit package execution contracts; developer process groups are not production tree proofs. */
public final class ManagedExtensionExecutionProfile {
    public static final String LINUX_CAPABILITY_DIGEST = "sha256:6210cbb69834af346af934d3a6db53827548365c247898bbdd23c323b459cb2c";
    public static final String DEVELOPER_CAPABILITY_DIGEST = "sha256:24be30e28acb08bb97a1ddb1ce5c74f830561a41dc171903d80929d1716b62bd";

    private ManagedExtensionExecutionProfile() {}

    public static boolean admits(String digest) {
        return LINUX_CAPABILITY_DIGEST.equals(digest) || DEVELOPER_CAPABILITY_DIGEST.equals(digest);
    }

    public static String mode(String digest) {
        if (LINUX_CAPABILITY_DIGEST.equals(digest)) {
            return "linux-cgroup";
        }
        if (DEVELOPER_CAPABILITY_DIGEST.equals(digest)) {
            return "developer-process-group";
        }
        throw new IllegalArgumentException("Unsupported extension execution capability");
    }

    public static Map<String, Object> configuration(String digest, String cacheDirectory, String cgroupRoot) {
        if (cacheDirectory == null || !Path.of(cacheDirectory).isAbsolute()) {
            throw new IllegalArgumentException("Managed extension cache directory must be absolute");
        }
        if (LINUX_CAPABILITY_DIGEST.equals(digest)) {
            if (cgroupRoot == null || !Path.of(cgroupRoot).isAbsolute()) {
                throw new IllegalArgumentException("Linux extensions require a delegated cgroup root");
            }
            return Map.of("enabled", true, "mode", mode(digest), "cacheDirectory", cacheDirectory, "cgroupRoot", cgroupRoot);
        }
        if (cgroupRoot != null && !cgroupRoot.isBlank()) {
            throw new IllegalArgumentException("Developer process-group mode does not accept a cgroup root");
        }
        return Map.of("enabled", true, "mode", mode(digest), "cacheDirectory", cacheDirectory);
    }
}
