package com.alibaba.acp.sdk.transport.process;

import java.util.function.Consumer;

import com.alibaba.acp.sdk.utils.Timeout;

/**
 * Options for configuring ProcessTransport
 *
 * This class provides configuration options for ProcessTransport, including working directory,
 * command arguments, error handling, and timeouts for different operations.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class ProcessTransportOptions {
    private String cwd;
    private String[] commandArgs;
    private Consumer<String> errorHandler;
    private Timeout turnTimeout;
    private Timeout messageTimeout;

    /**
     * Gets the current working directory for the process
     *
     * @return The current working directory
     */
    public String getCwd() {
        return cwd;
    }

    /**
     * Sets the current working directory for the process
     *
     * @param cwd The current working directory
     * @return Current instance for method chaining
     */
    public ProcessTransportOptions setCwd(String cwd) {
        this.cwd = cwd;
        return this;
    }

    /**
     * Gets the command arguments for the process
     *
     * @return Array of command arguments
     */
    public String[] getCommandArgs() {
        return commandArgs;
    }

    /**
     * Sets the command arguments for the process
     *
     * @param commandArgs Array of command arguments
     * @return Current instance for method chaining
     */
    public ProcessTransportOptions setCommandArgs(String[] commandArgs) {
        this.commandArgs = commandArgs;
        return this;
    }

    /**
     * Gets the error handler for processing error messages
     *
     * @return Consumer for handling error messages
     */
    public Consumer<String> getErrorHandler() {
        return errorHandler;
    }

    /**
     * Sets the error handler for processing error messages
     *
     * @param errorHandler Consumer for handling error messages
     * @return Current instance for method chaining
     */
    public ProcessTransportOptions setErrorHandler(Consumer<String> errorHandler) {
        this.errorHandler = errorHandler;
        return this;
    }

    /**
     * Gets the timeout for a turn (conversation round)
     *
     * @return Timeout for a turn
     */
    public Timeout getTurnTimeout() {
        return turnTimeout;
    }

    /**
     * Sets the timeout for a turn (conversation round)
     *
     * @param turnTimeout Timeout for a turn
     * @return Current instance for method chaining
     */
    public ProcessTransportOptions setTurnTimeout(Timeout turnTimeout) {
        this.turnTimeout = turnTimeout;
        return this;
    }

    /**
     * Gets the timeout for individual messages
     *
     * @return Timeout for individual messages
     */
    public Timeout getMessageTimeout() {
        return messageTimeout;
    }

    /**
     * Sets the timeout for individual messages
     *
     * @param messageTimeout Timeout for individual messages
     * @return Current instance for method chaining
     */
    public ProcessTransportOptions setMessageTimeout(Timeout messageTimeout) {
        this.messageTimeout = messageTimeout;
        return this;
    }
}
