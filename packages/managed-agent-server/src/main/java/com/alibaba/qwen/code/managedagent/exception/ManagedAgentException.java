package com.alibaba.qwen.code.managedagent.exception;

import org.springframework.http.HttpStatus;

import java.util.Map;

public class ManagedAgentException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final Map<String, Object> details;

    public ManagedAgentException(HttpStatus status, String code, String message) {
        this(status, code, message, Map.of());
    }

    public ManagedAgentException(HttpStatus status, String code, String message,
            Throwable cause) {
        this(status, code, message, Map.of(), cause);
    }

    /**
     * Creates an error whose envelope carries {@code details} next to its code,
     * message and request id.
     */
    public ManagedAgentException(HttpStatus status, String code, String message,
            Map<String, Object> details) {
        this(status, code, message, details, null);
    }

    private ManagedAgentException(HttpStatus status, String code, String message,
            Map<String, Object> details, Throwable cause) {
        super(message, cause);
        this.status = status;
        this.code = code;
        this.details = Map.copyOf(details);
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public Map<String, Object> getDetails() {
        return details;
    }
}
