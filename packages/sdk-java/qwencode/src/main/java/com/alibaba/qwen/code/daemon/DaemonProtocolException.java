package com.alibaba.qwen.code.daemon;

/** A malformed or unsupported daemon protocol response. */
public final class DaemonProtocolException extends DaemonException {
    DaemonProtocolException(String message) {
        super(message);
    }

    DaemonProtocolException(String message, Throwable cause) {
        super(message, cause);
    }
}
