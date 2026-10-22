package com.alibaba.qwen.code.daemon;

import java.time.Duration;

/**
 * The Hosted Harness event stream stayed silent past its idle bound while
 * a consumer waited on it. The Harness sends keepalive comments on this
 * stream, so the silence means the connection or the Harness is gone.
 * It proves nothing about the work the stream reported on: reconcile from
 * the durable record, never replay on it.
 */
public final class HostedHarnessStreamIdleException
        extends DaemonTransportException {
    private final Duration idleTimeout;

    HostedHarnessStreamIdleException(Duration idleTimeout) {
        super("Hosted Harness SSE idle timeout");
        this.idleTimeout = idleTimeout;
    }

    HostedHarnessStreamIdleException(Duration idleTimeout, Throwable cause) {
        super("Hosted Harness SSE idle timeout", cause);
        this.idleTimeout = idleTimeout;
    }

    /** The silence that tripped the bound. */
    public Duration getIdleTimeout() {
        return idleTimeout;
    }
}
