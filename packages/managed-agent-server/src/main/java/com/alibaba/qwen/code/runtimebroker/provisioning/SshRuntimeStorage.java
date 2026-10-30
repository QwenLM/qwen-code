package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;

import java.util.Map;

/** Saved remote directory identity and marker supplied by the storage registry. */
public record SshRuntimeStorage(String nodeId, String storageId, String mountRoot,
        Map<String, Object> registration) {
    public SshRuntimeStorage {
        BrokerValues.requireId(nodeId, "nodeId");
        ManagedContextProtocol.storageId(storageId);
        if (mountRoot == null || !mountRoot.startsWith("/") || registration == null
                || !(registration.get("identity") instanceof Map<?, ?> identity)
                || !(registration.get("marker") instanceof Map<?, ?> marker)
                || !(registration.get("qwenVersion") instanceof String qwenVersion) || qwenVersion.isBlank()
                || !mountRoot.equals(identity.get("root")) || !mountRoot.equals(marker.get("root"))
                || !storageId.equals(marker.get("storageId"))) {
            throw new IllegalArgumentException("SSH storage registration is incomplete");
        }
        registration = BrokerValues.immutableMap(registration);
    }
}
