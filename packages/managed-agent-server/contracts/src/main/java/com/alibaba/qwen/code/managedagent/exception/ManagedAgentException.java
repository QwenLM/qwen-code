package com.alibaba.qwen.code.managedagent.exception;

import java.util.Map;

public class ManagedAgentException extends RuntimeException {
    private final int status;
    private final String code;
    private final Map<String, Object> details;

    public ManagedAgentException(int status, String code, String message) {
        this(status, code, message, Map.of());
    }

    public ManagedAgentException(int status, String code, String message,
            Throwable cause) {
        this(status, code, message, Map.of(), cause);
    }

    /**
     * Creates an error whose envelope carries {@code details} next to its code,
     * message and request id.
     */
    public ManagedAgentException(int status, String code, String message,
            Map<String, Object> details) {
        this(status, code, message, details, null);
    }

    private ManagedAgentException(int status, String code, String message,
            Map<String, Object> details, Throwable cause) {
        super(message, cause);
        this.status = status;
        this.code = code;
        this.details = Map.copyOf(details);
    }

    public int getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public Map<String, Object> getDetails() {
        return details;
    }
}
