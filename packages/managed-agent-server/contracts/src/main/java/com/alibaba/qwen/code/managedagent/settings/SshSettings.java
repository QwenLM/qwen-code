package com.alibaba.qwen.code.managedagent.settings;

import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeNode;

import java.util.List;

public interface SshSettings {
    public boolean isEnabled();
    public List<? extends Node> getNodes();
    public interface Access {
        public String tenantId();
        public String actorId();
    }
    public interface Node {
        public String nodeId();
        public String displayName();
        public String sshHost();
        public String nodeExecutable();
        public String qwenEntry();
        public String stateDirectory();
        public List<String> allowedRoots();
        public int publicationPort();
        public String qwenVersion();
        public List<? extends Access> access();
        public boolean admits(String tenantId, String actorId);
        public SshRuntimeNode runtimeNode();
    }
}
