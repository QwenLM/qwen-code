package com.alibaba.qwen.code.daemon;

/** A transport failure for an operation whose outcome is otherwise known. */
public class DaemonTransportException extends DaemonException {
    DaemonTransportException(String message, Throwable cause) {
        super(message, cause);
    }
}
