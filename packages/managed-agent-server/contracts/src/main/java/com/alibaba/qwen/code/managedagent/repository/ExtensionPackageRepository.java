package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Operation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Settings;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;

import java.util.List;
import java.util.Map;

public interface ExtensionPackageRepository {
    @FunctionalInterface
    public interface Access {
        public void require(boolean write); }
    public List<Package> list(String tenant, String workspace);
    public Package get(String tenant, String workspace, Pin pin);
    public boolean hasSettings(String tenant, String workspace, Pin pin);
    public Operation preparePublish(String tenant, String actor, String workspace, String extensionId,
            String id, String digest, String operationId, String requestDigest, String encodedManifest, Access access);
    public Operation finishPublish(String tenant, String actor, String workspace, String id,
            String digest, String operationId, long length, Operation operation, Access access);
    public Operation operation(String tenant, String actor, String workspace, String operationId, Access access);
    public Settings settings(String tenant, String actor, String workspace, String extensionId, Access access);
    public Operation saveSettings(String tenant, String actor, String workspace, String extensionId,
            String operationId, String requestDigest, SettingsCommand command, byte[] plaintext, Access access);
    public Map<String, String> settingsValues(String tenant, String workspace, String extensionId, long revision);
}
