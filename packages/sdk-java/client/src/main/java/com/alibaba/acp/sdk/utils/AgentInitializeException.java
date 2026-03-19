package com.alibaba.acp.sdk.utils;

import org.apache.commons.lang3.exception.ContextedException;
import org.apache.commons.lang3.exception.ExceptionContext;

/**
 * Exception thrown when an error occurs during agent initialization.
 *
 * This exception is used to indicate problems that occur when attempting to initialize
 * communication with an ACP agent, such as connection errors or protocol mismatches.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class AgentInitializeException extends ContextedException {
    /**
     * Constructs a new AgentInitializeException with no message or cause.
     */
    public AgentInitializeException() {
    }

    /**
     * Constructs a new AgentInitializeException with the specified message.
     *
     * @param message The error message
     */
    public AgentInitializeException(String message) {
        super(message);
    }

    /**
     * Constructs a new AgentInitializeException with the specified message and cause.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     */
    public AgentInitializeException(String message, Throwable cause) {
        super(message, cause);
    }

    /**
     * Constructs a new AgentInitializeException with the specified message, cause, and context.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     * @param context The exception context
     */
    public AgentInitializeException(String message, Throwable cause, ExceptionContext context) {
        super(message, cause, context);
    }

    /**
     * Constructs a new AgentInitializeException with the specified cause.
     *
     * @param cause The underlying cause of the exception
     */
    public AgentInitializeException(Throwable cause) {
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
    public AgentInitializeException addContextValue(String label, Object value) {
        super.addContextValue(label, value);
        return this;
    }
}
