package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.runtimebroker.provisioning.SshRuntimeNode;

import java.util.List;

public class SshRuntimeSettings {
    private boolean enabled;
    private List<Node> nodes = List.of();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public List<Node> getNodes() {
        return nodes;
    }

    public void setNodes(List<Node> nodes) {
        this.nodes = List.copyOf(nodes);
    }

    public record Access(String tenantId, String actorId) {
    }

    public record Node(String nodeId, String displayName, String sshHost,
            String nodeExecutable, String qwenEntry, String stateDirectory,
            List<String> allowedRoots, int publicationPort, String qwenVersion,
            List<Access> access) {
        public Node {
            allowedRoots = allowedRoots == null ? List.of() : List.copyOf(allowedRoots);
            access = access == null ? List.of() : List.copyOf(access);
            if (qwenVersion == null || qwenVersion.isBlank()) {
                throw new IllegalArgumentException("SSH node requires a pinned qwenVersion");
            }
            new SshRuntimeNode(nodeId, displayName, sshHost, nodeExecutable,
                    qwenEntry, stateDirectory, allowedRoots, publicationPort);
        }

        public boolean admits(String tenantId, String actorId) {
            return access.contains(new Access(tenantId, actorId));
        }

        public SshRuntimeNode runtimeNode() {
            return new SshRuntimeNode(nodeId, displayName, sshHost, nodeExecutable,
                    qwenEntry, stateDirectory, allowedRoots, publicationPort);
        }
    }
}
