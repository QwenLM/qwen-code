package com.alibaba.qwen.code.managedagent.harness.contracts;

import java.time.Duration;

public final class HarnessStreamIdleFailure extends HarnessTransportFailure {
    private final Duration idleTimeout;

    public HarnessStreamIdleFailure(String message, Throwable cause, Duration idleTimeout) {
        super(message, cause);
        this.idleTimeout = idleTimeout;
    }

    public Duration getIdleTimeout() {
        return idleTimeout;
    }
}
