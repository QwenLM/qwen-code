package com.alibaba.qwen.code.daemon;

/** The configured client-wide prompt or publication capacity is exhausted. */
public final class DaemonClientCapacityException extends DaemonException {
    DaemonClientCapacityException(Throwable cause) {
        super("DaemonClient capacity is exhausted", cause);
    }
}
