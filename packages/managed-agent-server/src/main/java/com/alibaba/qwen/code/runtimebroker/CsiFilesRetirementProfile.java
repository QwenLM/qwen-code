package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
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

    private CsiFilesRetirementProfile() {
    }

    public static RuntimeProvisionRequest request(ContextBinding workspace,
            String mountRoot, String sessionId) {
        if (workspace == null || !".".equals(workspace.getCwdRelative())
                || !CONTEXT_CONFIG_REF.equals(workspace.getContextConfigRef()) || sessionId == null
                || !UUID.fromString(sessionId).toString().equals(sessionId)
                || mountRoot == null || !mountRoot.startsWith("/")
                || mountRoot.equals("/") || mountRoot.endsWith("/")
                || mountRoot.contains("\\")) {
            throw new IllegalArgumentException("Invalid private CSI Session identity");
        }
        for (String component : mountRoot.substring(1).split("/", -1)) {
            if (component.isEmpty() || component.equals(".") || component.equals("..")) {
                throw new IllegalArgumentException("Invalid private CSI mount root");
            }
        }
        RuntimeScope scope = new RuntimeScope(workspace.getTenantId(), workspace.getWorkspaceId(),
                Long.toString(workspace.getWorkspaceGeneration()), mountRoot,
                CAPABILITY_DIGEST, "session");
        return new RuntimeProvisionRequest(scope, sessionId, PROVISIONER_KIND, workspace.getStorageId());
    }

    private static String digest(String value) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
