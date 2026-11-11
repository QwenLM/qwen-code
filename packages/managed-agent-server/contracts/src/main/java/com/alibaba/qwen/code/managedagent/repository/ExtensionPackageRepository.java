package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Operation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Package;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Settings;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SettingsCommand;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SourceImport;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.SourceOrigin;

import java.util.List;
import java.util.Map;

public interface ExtensionPackageRepository {
    @FunctionalInterface
    public interface Access {
        public void require(boolean write); }
    public List<Package> list(String tenant, String workspace);
    public Package get(String tenant, String workspace, Pin pin);
    public boolean hasSettings(String tenant, String workspace, Pin pin);
    public default Operation preparePublish(String tenant, String actor, String workspace, String extensionId,
            String id, String digest, String operationId, String requestDigest, String encodedManifest, Access access) {
        return preparePublish(tenant, actor, workspace, extensionId, id, digest, operationId, requestDigest, encodedManifest, null, access);
    }
    public Operation preparePublish(String tenant, String actor, String workspace, String extensionId,
            String id, String digest, String operationId, String requestDigest, String encodedManifest, SourceOrigin source, Access access);
    public Operation findOperation(String tenant, String actor, String workspace, String operationId, String requestDigest, Access access);
    public Package publication(String tenant, String workspace, Operation operation);
    public void prepareSourceImport(String tenant, String actor, String workspace, String operationId, String requestDigest, SourceImport command, Access access);
    public SourceImport sourceImport(String tenant, String actor, String workspace, String operationId, Access access);
    public Operation finishPublish(String tenant, String actor, String workspace, String id,
            String digest, String operationId, long length, Operation operation, Access access);
    public Operation operation(String tenant, String actor, String workspace, String operationId, Access access);
    public Settings settings(String tenant, String actor, String workspace, String extensionId, Access access);
    public Operation saveSettings(String tenant, String actor, String workspace, String extensionId,
            String operationId, String requestDigest, SettingsCommand command, byte[] plaintext, Access access);
    public Map<String, String> settingsValues(String tenant, String workspace, String extensionId, long revision);
}
