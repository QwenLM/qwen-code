package com.alibaba.qwen.code.daemon;

/** Base class for daemon client failures. */
public class DaemonException extends RuntimeException {
    public DaemonException(String message) {
        super(message);
    }

    public DaemonException(String message, Throwable cause) {
        super(message, cause);
    }
}
