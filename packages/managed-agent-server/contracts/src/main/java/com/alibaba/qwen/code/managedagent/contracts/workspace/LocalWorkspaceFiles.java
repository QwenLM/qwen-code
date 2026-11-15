package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.util.Map;
public interface LocalWorkspaceFiles {
    int MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    Map<String, Object> readFiles(String node, String entry, Map<String, Object> request);
    Map<String, Object> uploadFiles(String node, String entry, Map<String, Object> request);
    static RuntimeBrokerException unsupported() {
        return new RuntimeBrokerException(409, "workspace_files_unsupported", "Workspace file access requires an updated CLI.", false);
    }
}
