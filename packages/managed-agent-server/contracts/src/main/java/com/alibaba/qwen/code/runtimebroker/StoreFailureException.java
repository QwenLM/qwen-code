package com.alibaba.qwen.code.runtimebroker;

/** A store outage, distinct from a permanent repository invariant violation. */
public final class StoreFailureException extends IllegalStateException {
    public StoreFailureException(String message, Throwable cause) {
        super(message, cause);
    }
}
