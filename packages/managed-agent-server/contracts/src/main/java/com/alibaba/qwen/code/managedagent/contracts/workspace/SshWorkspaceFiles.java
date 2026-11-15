package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeNode;

import java.util.Map;
public interface SshWorkspaceFiles {
    record FileTarget(SshRuntimeNode node, Map<String, Object> request, String qwenVersion) { }
    Map<String, Object> files(ContextBinding binding, Map<String, Object> files);
    FileTarget freezeFiles(ContextBinding binding);
    Map<String, Object> upload(FileTarget target, Map<String, Object> files);
}
