package com.alibaba.qwen.code.runtimebroker;

import java.util.List;

/** Trusted server-side SSH configuration; never populated by a Workspace request. */
public record SshRuntimeNode(String nodeId, String displayName, String sshHost,
        String nodeExecutable, String qwenEntry, String stateDirectory,
        List<String> allowedRoots, int publicationPort) {
    public SshRuntimeNode {
        BrokerValues.requireId(nodeId, "nodeId");
        BrokerValues.requireId(displayName, "displayName");
        if (sshHost == null || !sshHost.matches("[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}")) {
            throw new IllegalArgumentException("SSH host must be a configured host alias");
        }
        absolute(nodeExecutable);
        absolute(qwenEntry);
        absolute(stateDirectory);
        allowedRoots = List.copyOf(allowedRoots);
        if (allowedRoots.isEmpty() || publicationPort < 1 || publicationPort > 65535) {
            throw new IllegalArgumentException("SSH roots and publication port are required");
        }
        allowedRoots.forEach(SshRuntimeNode::absolute);
    }

    private static void absolute(String path) {
        if (path == null || !path.startsWith("/") || path.codePoints().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("SSH paths must be absolute POSIX paths");
        }
    }
}
