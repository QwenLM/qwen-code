package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/** A daemon permission request observed during a prompt. */
public final class PermissionRequest {
    private final String requestId;
    private final Map<String, Object> toolCall;
    private final List<Object> options;

    PermissionRequest(String requestId, Map<String, Object> toolCall,
            List<Object> options) {
        this.requestId = requestId;
        this.toolCall = Collections.unmodifiableMap(toolCall);
        this.options = Collections.unmodifiableList(options);
    }

    static PermissionRequest from(DaemonEvent event) {
        Map<String, Object> data = event.requireDataObject(
                "permission_request.data");
        String requestId = JsonSupport.requiredString(data, "requestId",
                "permission_request.data");
        Map<String, Object> toolCall = JsonSupport.requiredObject(data, "toolCall",
                "permission_request.data");
        JsonSupport.requiredString(toolCall, "toolCallId",
                "permission_request.data.toolCall");
        List<Object> options = JsonSupport.optionalList(data, "options");
        if (options == null) {
            throw new DaemonProtocolException(
                    "permission_request.data.options must be an array");
        }
        for (int i = 0; i < options.size(); i++) {
            Map<String, Object> option = JsonSupport.extensionObject(options.get(i));
            if (option == null) {
                throw new DaemonProtocolException(
                        "permission_request.data.options[" + i
                                + "] must be an object");
            }
            JsonSupport.requiredString(option, "optionId",
                    "permission_request.data.options[" + i + "]");
        }
        return new PermissionRequest(requestId, toolCall, options);
    }

    public String getRequestId() {
        return requestId;
    }

    public Map<String, Object> getToolCall() {
        return toolCall;
    }

    public List<Object> getOptions() {
        return options;
    }
}
