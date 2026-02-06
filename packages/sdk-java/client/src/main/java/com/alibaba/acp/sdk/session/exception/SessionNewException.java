package com.alibaba.acp.sdk.session.exception;

import org.apache.commons.lang3.exception.ContextedException;
import org.apache.commons.lang3.exception.ExceptionContext;

/**
 * Exception thrown when an error occurs during session creation.
 *
 * This exception is used to indicate problems that occur when attempting to create a new session
 * with an ACP agent, such as communication errors or invalid session parameters.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class SessionNewException extends ContextedException {
    /**
     * Constructs a new SessionNewException with no message or cause.
     */
    public SessionNewException() {
    }

    /**
     * Constructs a new SessionNewException with the specified message.
     *
     * @param message The error message
     */
    public SessionNewException(String message) {
        super(message);
    }

    /**
     * Constructs a new SessionNewException with the specified message and cause.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     */
    public SessionNewException(String message, Throwable cause) {
        super(message, cause);
    }

    /**
     * Constructs a new SessionNewException with the specified message, cause, and context.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     * @param context The exception context
     */
    public SessionNewException(String message, Throwable cause, ExceptionContext context) {
        super(message, cause, context);
    }

    /**
     * Constructs a new SessionNewException with the specified cause.
     *
     * @param cause The underlying cause of the exception
     */
    public SessionNewException(Throwable cause) {
        super(cause);
    }

    @Override
    /**
     * Adds a context value to the exception for debugging purposes.
     *
     * @param label The label for the context value
     * @param value The context value
     * @return This exception instance for method chaining
     */
    public SessionNewException addContextValue(String label, Object value) {
        super.addContextValue(label, value);
        return this;
    }
}
