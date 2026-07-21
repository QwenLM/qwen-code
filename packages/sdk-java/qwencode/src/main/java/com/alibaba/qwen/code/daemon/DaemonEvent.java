package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.Map;

/** One validated daemon SSE event envelope. */
public final class DaemonEvent {
    private final Long id;
    private final int version;
    private final String type;
    private final Object data;
    private final String promptId;
    private final String originatorClientId;
    private final Map<String, Object> metadata;

    DaemonEvent(Long id, int version, String type, Object data,
            String promptId, String originatorClientId,
            Map<String, Object> metadata) {
        this.id = id;
        this.version = version;
        this.type = type;
        this.data = data;
        this.promptId = promptId;
        this.originatorClientId = originatorClientId;
        this.metadata = Collections.unmodifiableMap(metadata);
    }

    public Long getId() {
        return id;
    }

    public int getVersion() {
        return version;
    }

    public String getType() {
        return type;
    }

    public Object getData() {
        return data;
    }

    public String getPromptId() {
        return promptId;
    }

    public String getOriginatorClientId() {
        return originatorClientId;
    }

    public Map<String, Object> getMetadata() {
        return metadata;
    }

    boolean belongsTo(String expectedPromptId) {
        if (!("turn_complete".equals(type) || "turn_error".equals(type))) {
            return expectedPromptId.equals(promptId);
        }
        Map<String, Object> object = dataObject();
        String dataPromptId = object == null ? null
                : JsonSupport.optionalString(object, "promptId");
        if (promptId != null && dataPromptId != null
                && !promptId.equals(dataPromptId)) {
            throw new DaemonProtocolException(
                    "SSE envelope promptId conflicts with data.promptId");
        }
        String canonicalPromptId = promptId == null ? dataPromptId : promptId;
        return expectedPromptId.equals(canonicalPromptId);
    }

    String updateKind() {
        return JsonSupport.requiredString(update(), "sessionUpdate",
                "session_update.data.update");
    }

    String textChunk() {
        Map<String, Object> content = JsonSupport.requiredObject(update(),
                "content", "session_update.data.update");
        String contentType = JsonSupport.requiredString(content, "type",
                "session_update.data.update.content");
        if (!"text".equals(contentType)) {
            return null;
        }
        Object text = content.get("text");
        if (!(text instanceof String)) {
            throw new DaemonProtocolException(
                    "session_update.data.update.content.text must be a string");
        }
        return (String) text;
    }

    Map<String, Object> update() {
        return JsonSupport.requiredObject(
                requireDataObject("session_update.data"), "update",
                "session_update.data");
    }

    Map<String, Object> requireDataObject(String context) {
        Map<String, Object> object = dataObject();
        if (object == null) {
            throw new DaemonProtocolException(context + " must be an object");
        }
        return object;
    }

    void requireSessionId(String expectedSessionId, String context) {
        String actualSessionId = JsonSupport.requiredString(
                requireDataObject(context + ".data"), "sessionId",
                context + ".data");
        if (!expectedSessionId.equals(actualSessionId)) {
            throw new DaemonProtocolException(context
                    + ".data.sessionId does not match the session");
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> dataObject() {
        return data instanceof Map ? (Map<String, Object>) data : null;
    }
}
