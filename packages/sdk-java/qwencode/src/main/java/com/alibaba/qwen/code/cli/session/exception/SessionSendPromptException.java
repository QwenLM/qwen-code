package com.alibaba.qwen.code.cli.session.exception;

/**
 * Exception thrown when sending a prompt in a session fails.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class SessionSendPromptException extends Exception {
    /**
     * Creates a new exception.
     */
    public SessionSendPromptException() {
    }

    /**
     * Creates a new exception with a message.
     *
     * @param message The exception message
     */
    public SessionSendPromptException(String message) {
        super(message);
    }

    /**
     * Creates a new exception with a message and cause.
     *
     * @param message The exception message
     * @param cause The exception cause
     */
    public SessionSendPromptException(String message, Throwable cause) {
        super(message, cause);
    }

    /**
     * Creates a new exception with a cause.
     *
     * @param cause The exception cause
     */
    public SessionSendPromptException(Throwable cause) {
        super(cause);
    }

    /**
     * Creates a new exception with all parameters.
     *
     * @param message The exception message
     * @param cause The exception cause
     * @param enableSuppression Whether suppression is enabled
     * @param writableStackTrace Whether the stack trace is writable
     */
    public SessionSendPromptException(String message, Throwable cause, boolean enableSuppression, boolean writableStackTrace) {
        super(message, cause, enableSuppression, writableStackTrace);
    }
}
