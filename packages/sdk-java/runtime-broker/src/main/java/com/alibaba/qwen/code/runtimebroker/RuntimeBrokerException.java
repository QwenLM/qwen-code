package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

/** Stable service error that an embedding adapter can map to its protocol. */
public final class RuntimeBrokerException extends RuntimeException {
    private final int statusCode;
    private final String code;
    private final boolean retryable;
    private final Map<String, Object> details;

    public RuntimeBrokerException(int statusCode, String code,
            String message, boolean retryable) {
        this(statusCode, code, message, retryable, null);
    }

    public RuntimeBrokerException(int statusCode, String code,
            String message, boolean retryable, Throwable cause) {
        this(statusCode, code, message, retryable, cause, Map.of());
    }

    RuntimeBrokerException(int statusCode, String code, String message,
            boolean retryable, Throwable cause, Map<String, Object> details) {
        super(message, cause);
        this.details = Map.copyOf(details);
        if (statusCode < 400 || statusCode > 599) {
            throw new IllegalArgumentException(
                    "statusCode must be an error status");
        }
        this.code = BrokerValues.requireId(code, "code");
        this.statusCode = statusCode;
        this.retryable = retryable;
    }

    public Map<String, Object> getDetails() {
        return details;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getCode() {
        return code;
    }

    public boolean isRetryable() {
        return retryable;
    }
}
