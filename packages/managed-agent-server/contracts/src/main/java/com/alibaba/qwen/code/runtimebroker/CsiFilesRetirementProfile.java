package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Private Session-isolated file profile; it does not enable a worker. */
public final class CsiFilesRetirementProfile {
    public static final String PROFILE = "csi-files-retirement/1";
    public static final String CONFIG_REF = "csi-files-retirement-tools/1";
    public static final String POLICY_REF = "csi-files-retirement-policy/1";
    public static final String PROVISIONER_KIND = "kubernetes-workspace";
    public static final String CONTEXT_CONFIG_REF = digest(CONFIG_REF + "\u0000" + POLICY_REF);
    public static final String CAPABILITY_MANIFEST = "{\"profile\":\"csi-files-retirement/1\","
            + "\"tools\":[\"read_file\",\"write_file\",\"edit\"],\"fileHistory\":true,"
            + "\"invocationProtocol\":2,\"resultRetention\":\"until-finalize\"}";
    public static final String CAPABILITY_DIGEST = digest(CAPABILITY_MANIFEST);
    public static final String DIAGNOSTICS_PROFILE = "csi-files-retirement/2";
    public static final String DIAGNOSTICS_MANIFEST = "{\"profile\":\"csi-files-retirement/2\","
            + "\"tools\":[\"read_file\",\"write_file\",\"edit\"],\"fileHistory\":true,"
            + "\"invocationProtocol\":2,\"resultRetention\":\"until-finalize\",\"diagnostics\":\"model-v1\"}";
    public static final String DIAGNOSTICS_DIGEST = digest(DIAGNOSTICS_MANIFEST);
    public static final String ACTIVITY_PROFILE = "csi-files-retirement/3";
    public static final String ACTIVITY_MANIFEST = "{\"profile\":\"csi-files-retirement/3\","
            + "\"tools\":[\"read_file\",\"write_file\",\"edit\"],\"fileHistory\":true,"
            + "\"invocationProtocol\":2,\"resultRetention\":\"until-finalize\",\"diagnostics\":\"model-v1\",\"activityDiagnostics\":\"activity-v1\"}";
    public static final String ACTIVITY_DIGEST = digest(ACTIVITY_MANIFEST);
    public static final String OBJECTS_PROFILE = "csi-files-retirement/4";
    public static final String OBJECTS_MANIFEST = "{\"profile\":\"csi-files-retirement/4\","
            + "\"tools\":[\"read_file\",\"write_file\",\"edit\"],\"fileHistory\":true,"
            + "\"invocationProtocol\":2,\"resultRetention\":\"until-finalize\",\"diagnostics\":\"model-v1\",\"activityDiagnostics\":\"activity-v1\",\"sessionObjects\":\"immutable-v1\"}";
    public static final String OBJECTS_DIGEST = digest(OBJECTS_MANIFEST);

    private CsiFilesRetirementProfile() {
    }

    public static RuntimeProvisionRequest request(ContextBinding workspace,
            String mountRoot, String sessionId) {
        return request(workspace, mountRoot, sessionId, PROFILE);
    }

    public static RuntimeProvisionRequest request(ContextBinding workspace,
            String mountRoot, String sessionId, String profile) {
        if (workspace == null || !".".equals(workspace.getCwdRelative())
                || !CONTEXT_CONFIG_REF.equals(workspace.getContextConfigRef()) || sessionId == null
                || !UUID.fromString(sessionId).toString().equals(sessionId)
                || mountRoot == null || !mountRoot.startsWith("/")
                || mountRoot.equals("/") || mountRoot.endsWith("/")
                || mountRoot.contains("\\") || !isProfile(profile)) {
            throw new IllegalArgumentException("Invalid private CSI Session identity");
        }
        for (String component : mountRoot.substring(1).split("/", -1)) {
            if (component.isEmpty() || component.equals(".") || component.equals("..")) {
                throw new IllegalArgumentException("Invalid private CSI mount root");
            }
        }
        RuntimeScope scope = new RuntimeScope(workspace.getTenantId(), workspace.getWorkspaceId(),
                Long.toString(workspace.getWorkspaceGeneration()), mountRoot,
                OBJECTS_PROFILE.equals(profile) ? OBJECTS_DIGEST : ACTIVITY_PROFILE.equals(profile) ? ACTIVITY_DIGEST : DIAGNOSTICS_PROFILE.equals(profile) ? DIAGNOSTICS_DIGEST : CAPABILITY_DIGEST, "session");
        return new RuntimeProvisionRequest(scope, sessionId, PROVISIONER_KIND, workspace.getStorageId());
    }

    private static String digest(String value) {
        return "sha256:" + DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }
    public static boolean isProfile(RuntimeScope scope) {
        return scope != null && isCapabilityDigest(scope.getCapabilityDigest());
    }

    public static boolean isCapabilityDigest(String digest) {
        return CAPABILITY_DIGEST.equals(digest) || DIAGNOSTICS_DIGEST.equals(digest) || ACTIVITY_DIGEST.equals(digest) || OBJECTS_DIGEST.equals(digest);
    }

    public static boolean matches(Object profile, Object digest) {
        return PROFILE.equals(profile) && CAPABILITY_DIGEST.equals(digest)
                || DIAGNOSTICS_PROFILE.equals(profile) && DIAGNOSTICS_DIGEST.equals(digest)
                || ACTIVITY_PROFILE.equals(profile) && ACTIVITY_DIGEST.equals(digest)
                || OBJECTS_PROFILE.equals(profile) && OBJECTS_DIGEST.equals(digest);
    }

    public static boolean isProfile(String profile) {
        return PROFILE.equals(profile) || DIAGNOSTICS_PROFILE.equals(profile) || ACTIVITY_PROFILE.equals(profile) || OBJECTS_PROFILE.equals(profile);
    }

    public static boolean hasDiagnostics(RuntimeScope scope) {
        return scope != null && (DIAGNOSTICS_DIGEST.equals(scope.getCapabilityDigest()) || hasActivityDiagnostics(scope));
    }

    public static boolean hasActivityDiagnostics(RuntimeScope scope) {
        return scope != null && (ACTIVITY_DIGEST.equals(scope.getCapabilityDigest()) || OBJECTS_DIGEST.equals(scope.getCapabilityDigest()));
    }

    public static String profile(RuntimeScope scope) {
        if (!isProfile(scope)) {
            throw new IllegalArgumentException("Unknown private CSI profile");
        }
        return OBJECTS_DIGEST.equals(scope.getCapabilityDigest()) ? OBJECTS_PROFILE : hasActivityDiagnostics(scope) ? ACTIVITY_PROFILE : hasDiagnostics(scope) ? DIAGNOSTICS_PROFILE : PROFILE;
    }

    public static boolean supportsStorage(RuntimeScope scope, long version) {
        return isProfile(scope) && (version == 1 || version == 3 && hasDiagnostics(scope) || version == 4 && hasActivityDiagnostics(scope)
                || version == 6 && OBJECTS_DIGEST.equals(scope.getCapabilityDigest()));
    }

    public static RuntimeBrokerException releaseUnavailable() {
        return new RuntimeBrokerException(409, "csi_finalize_required",
                "The original CSI Session requires retirement finalization.", false);
    }
}
