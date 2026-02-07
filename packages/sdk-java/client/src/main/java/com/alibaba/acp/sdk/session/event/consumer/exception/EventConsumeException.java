package com.alibaba.acp.sdk.session.event.consumer.exception;

import com.alibaba.acp.sdk.protocol.jsonrpc.Error;

import org.apache.commons.lang3.exception.ContextedRuntimeException;
import org.apache.commons.lang3.exception.ExceptionContext;

/**
 * Exception thrown when an error occurs during event consumption.
 *
 * This exception is used to indicate problems that occur when processing events
 * from an ACP agent, such as invalid request parameters or processing errors.
 * It includes an error object that can be sent back to the agent.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class EventConsumeException extends ContextedRuntimeException {
    /**
     * Constructs a new EventConsumeException with no message or cause.
     */
    public EventConsumeException() {
    }

    /**
     * Constructs a new EventConsumeException with the specified message.
     *
     * @param message The error message
     */
    public EventConsumeException(String message) {
        super(message);
    }

    /**
     * Constructs a new EventConsumeException with the specified message and cause.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     */
    public EventConsumeException(String message, Throwable cause) {
        super(message, cause);
    }

    /**
     * Constructs a new EventConsumeException with the specified message, cause, and context.
     *
     * @param message The error message
     * @param cause The underlying cause of the exception
     * @param context The exception context
     */
    public EventConsumeException(String message, Throwable cause, ExceptionContext context) {
        super(message, cause, context);
    }

    /**
     * Constructs a new EventConsumeException with the specified cause.
     *
     * @param cause The underlying cause of the exception
     */
    public EventConsumeException(Throwable cause) {
        super(cause);
    }

    private final Error error = new Error();

    /**
     * Sets the error details for this exception.
     *
     * @param code The error code
     * @param message The error message
     * @param detail Additional error details
     * @return This exception instance for method chaining
     */
    public EventConsumeException setError(int code, String message, Object detail) {
        error.setCode(code);
        error.setMessage(message);
        error.setData(detail);
        return this;
    }

    /**
     * Gets the error object associated with this exception.
     *
     * @return The error object that can be sent back to the agent
     */
    public Error getError() {
        return error;
    }
}
