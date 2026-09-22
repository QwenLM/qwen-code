package com.alibaba.qwen.code.runtimebroker;

/** A bounded, client-safe Runtime Broker failure. */
public final class RuntimeBrokerException extends RuntimeException {
    private final int statusCode;
    private final String code;
    private final boolean retryable;

    public RuntimeBrokerException(int statusCode, String code,
            String message, boolean retryable) {
        super(message);
        validateStatus(statusCode);
        this.statusCode = statusCode;
        this.code = BrokerValues.requireId(code, "code");
        this.retryable = retryable;
    }

    public RuntimeBrokerException(int statusCode, String code,
            String message, boolean retryable, Throwable cause) {
        super(message, cause);
        validateStatus(statusCode);
        this.statusCode = statusCode;
        this.code = BrokerValues.requireId(code, "code");
        this.retryable = retryable;
    }

    private static void validateStatus(int statusCode) {
        if (statusCode < 400 || statusCode > 599) {
            throw new IllegalArgumentException(
                    "statusCode must be an error status");
        }
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
