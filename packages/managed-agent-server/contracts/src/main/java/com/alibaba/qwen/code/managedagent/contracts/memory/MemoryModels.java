package com.alibaba.qwen.code.managedagent.contracts.memory;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.apache.commons.lang3.StringUtils;

import java.util.List;
import java.util.Set;

public final class MemoryModels {
    private MemoryModels() { }

    public record Store(String id, @JsonProperty("created_at") long createdAt) { }
    public record StoreList(List<Store> data) { }

    public record Query(String workspaceId, String writerId, long writerGeneration,
            String operation, String inputId, String callId, String query, String content,
            String memoryId, String expectedContent) {
        public void validate() {
            if (!text(workspaceId, 512) || !text(writerId, 512) || writerGeneration < 1
                    || writerGeneration > 9007199254740991L || operation == null
                    || !Set.of("binding", "recall", "search", "remember", "get", "forget").contains(operation)) {
                throw invalid();
            }
            if ("binding".equals(operation)) {
                if (inputId != null || callId != null || query != null || content != null
                        || memoryId != null || expectedContent != null) {
                    throw invalid();
                }
                return;
            }
            if (!text(inputId, 512) || !text(callId, 512)
                    || ("recall".equals(operation) || "search".equals(operation))
                        && !text(query, "recall".equals(operation) ? 512 : 2000)
                    || "remember".equals(operation) && !text(content, 4000)
                    || ("get".equals(operation) || "forget".equals(operation)) && !identifier(memoryId)
                    || "forget".equals(operation) && !text(expectedContent, 4000)) {
                throw invalid();
            }
        }
    }

    public record Item(String memoryId, String content) { }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Result(String status, List<Item> items, String memoryId, String content,
            Boolean enabled, String memoryStoreId) {
        public static Result status(String value) { return new Result(value, null, null, null, null, null); }
        public static Result binding(String store) { return new Result(null, null, null, null, store != null, store); }
        public static Result items(List<Item> items) { return new Result("ok", List.copyOf(items), null, null, null, null); }
        public static Result entry(String status, String id, String content) {
            return new Result(status, null, id, content, null, null);
        }
    }

    public record Admission(String tenantId, String sessionId, String storeId, String namespace,
            String key, String digest, Query query, Result replay) { }

    public static boolean text(String value, int limit) {
        if (StringUtils.isBlank(value) || value.codePointCount(0, value.length()) > limit) {
            return false;
        }
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            if (Character.isHighSurrogate(character)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) {
                    return false;
                }
            } else if (Character.isLowSurrogate(character)) {
                return false;
            }
        }
        return true;
    }

    public static boolean identifier(String value) {
        return value != null && value.matches("[A-Za-z0-9._:-]{1,256}")
                && !".".equals(value) && !"..".equals(value);
    }

    public static ManagedAgentException invalid() {
        return new ManagedAgentException(400, "invalid_memory_request", "Invalid memory request.");
    }
}
