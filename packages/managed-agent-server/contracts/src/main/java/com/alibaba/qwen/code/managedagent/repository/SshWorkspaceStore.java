package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeStorage;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public interface SshWorkspaceStore {
    public static final TypeReference<LinkedHashMap<String, Object>> MAP = new TypeReference<>() { };

    public static final String KIND = "SSH_LOCAL";

    public static final String OPERATION = "WORKSPACE_CREATE";

    public record Operation(String operationId, String type, String status,
            String workspaceId, String failureCode, boolean replayed) {
    }

    public record Intent(String operationId, String tenantId, String actorId,
            String nodeId, String path, String displayName, String workspaceId,
            String storageId, String registrationId, Map<String, Object> registration) {
    }

    public record Parked(Intent intent, String failureCode) {
        public boolean reserved() {
            return !intent.registration().isEmpty();
        }
    }

    public Operation begin(String tenant, String actor, String key,
            String node, String path, String name);

    public Operation get(String tenant, String actor, String id);

    public Operation replay(String tenant, String actor, String key,
            String node, String path, String name);

    public Intent claim(String tenant, String actor, String id, String owner);

    public void reserve(Intent intent, String owner, Map<String, Object> registration);

    public void complete(Intent intent, String owner);

    public void fail(Intent intent, String owner, String code, boolean retryable);

    public List<StoreModels.ParkedOperation> findParked(int limit);

    public java.util.Optional<Parked> parked(String tenant, String operationId);

    public boolean completeParked(String tenant, String operationId);

    public boolean releaseParked(String tenant, String operationId, String code);

    public boolean reparkParked(String tenant, String operationId, long delayMillis);

    public SshRuntimeStorage runtimeStorage(RuntimeScope scope);

    public SshRuntimeStorage runtimeStorage(String tenant, String storage);

    public boolean verify(ContextBinding binding);

    public static Map<String, Object> object(Map<String, Object> value, String key) {
        return Codec.JSON.convertValue(Objects.requireNonNull(value.get(key), key), MAP);
    }

    public static String string(Map<String, Object> value, String key) {
        if (!(value.get(key) instanceof String text) || text.isBlank()) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        return text;
    }
    final class Codec {
        private static final ObjectMapper JSON = new ObjectMapper();

        private Codec() { }
    }
}
