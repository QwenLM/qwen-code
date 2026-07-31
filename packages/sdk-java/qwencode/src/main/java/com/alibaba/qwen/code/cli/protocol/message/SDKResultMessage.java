package com.alibaba.qwen.code.cli.protocol.message;

import java.util.List;
import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.CLIPermissionDenial;
import com.alibaba.qwen.code.cli.protocol.data.ExtendedUsage;
import com.alibaba.qwen.code.cli.protocol.data.Usage;

/**
 * Represents a result message from the SDK.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "result")
public class SDKResultMessage extends MessageBase {
    /**
     * The subtype of the result.
     */
    private String subtype; // 'error_max_turns' | 'error_during_execution'
    /**
     * The UUID of the message.
     */
    private String uuid;

    /**
     * The session ID.
     */
    @JSONField(name = "session_id")
    private String sessionId;

    /**
     * Whether the result represents an error.
     */
    @JSONField(name = "is_error")
    private boolean isError = true;

    /**
     * Duration in milliseconds.
     */
    @JSONField(name = "duration_ms")
    private Long durationMs;

    /**
     * API duration in milliseconds.
     */
    @JSONField(name = "duration_api_ms")
    private Long durationApiMs;

    /**
     * Number of turns.
     */
    @JSONField(name = "num_turns")
    private Integer numTurns;
    /**
     * Usage information.
     */
    private ExtendedUsage usage;
    /**
     * Model usage information.
     */
    private Map<String, Usage> modelUsage;

    /**
     * List of permission denials.
     */
    @JSONField(name = "permission_denials")
    private List<CLIPermissionDenial> permissionDenials;
    /**
     * Error information.
     */
    private Error error;

    /**
     * Creates a new SDKResultMessage instance and sets the type to "result".
     */
    public SDKResultMessage() {
        super();
        this.type = "result";
    }

    /**
     * Gets the subtype of the result.
     *
     * @return The subtype of the result
     */
    public String getSubtype() {
        return subtype;
    }

    /**
     * Sets the subtype of the result.
     *
     * @param subtype The subtype of the result
     */
    public void setSubtype(String subtype) {
        this.subtype = subtype;
    }

    /**
     * Gets the UUID of the message.
     *
     * @return The UUID of the message
     */
    public String getUuid() {
        return uuid;
    }

    /**
     * Sets the UUID of the message.
     *
     * @param uuid The UUID of the message
     */
    public void setUuid(String uuid) {
        this.uuid = uuid;
    }

    /**
     * Gets the session ID.
     *
     * @return The session ID
     */
    public String getSessionId() {
        return sessionId;
    }

    /**
     * Sets the session ID.
     *
     * @param sessionId The session ID
     */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    /**
     * Checks if the result represents an error.
     *
     * @return Whether the result represents an error
     */
    public boolean isError() {
        return isError;
    }

    /**
     * Sets whether the result represents an error.
     *
     * @param error Whether the result represents an error
     */
    public void setError(boolean error) {
        isError = error;
    }

    /**
     * Gets the duration in milliseconds.
     *
     * @return The duration in milliseconds
     */
    public Long getDurationMs() {
        return durationMs;
    }

    /**
     * Sets the duration in milliseconds.
     *
     * @param durationMs The duration in milliseconds
     */
    public void setDurationMs(Long durationMs) {
        this.durationMs = durationMs;
    }

    /**
     * Gets the API duration in milliseconds.
     *
     * @return The API duration in milliseconds
     */
    public Long getDurationApiMs() {
        return durationApiMs;
    }

    /**
     * Sets the API duration in milliseconds.
     *
     * @param durationApiMs The API duration in milliseconds
     */
    public void setDurationApiMs(Long durationApiMs) {
        this.durationApiMs = durationApiMs;
    }

    /**
     * Gets the number of turns.
     *
     * @return The number of turns
     */
    public Integer getNumTurns() {
        return numTurns;
    }

    /**
     * Sets the number of turns.
     *
     * @param numTurns The number of turns
     */
    public void setNumTurns(Integer numTurns) {
        this.numTurns = numTurns;
    }

    /**
     * Gets the usage information.
     *
     * @return The usage information
     */
    public ExtendedUsage getUsage() {
        return usage;
    }

    /**
     * Sets the usage information.
     *
     * @param usage The usage information
     */
    public void setUsage(ExtendedUsage usage) {
        this.usage = usage;
    }

    /**
     * Gets the model usage information.
     *
     * @return The model usage information
     */
    public Map<String, Usage> getModelUsage() {
        return modelUsage;
    }

    /**
     * Sets the model usage information.
     *
     * @param modelUsage The model usage information
     */
    public void setModelUsage(Map<String, Usage> modelUsage) {
        this.modelUsage = modelUsage;
    }

    /**
     * Gets the list of permission denials.
     *
     * @return The list of permission denials
     */
    public List<CLIPermissionDenial> getPermissionDenials() {
        return permissionDenials;
    }

    /**
     * Sets the list of permission denials.
     *
     * @param permissionDenials The list of permission denials
     */
    public void setPermissionDenials(List<CLIPermissionDenial> permissionDenials) {
        this.permissionDenials = permissionDenials;
    }

    /**
     * Gets the error information.
     *
     * @return The error information
     */
    public Error getError() {
        return error;
    }

    /**
     * Sets the error information.
     *
     * @param error The error information
     */
    public void setError(Error error) {
        this.error = error;
    }

    /**
     * Represents error information.
     */
    public static class Error {
        /**
         * Error type.
         */
        private String type;
        /**
         * Error message.
         */
        private String message;

        /**
         * Gets the error type.
         *
         * @return The error type
         */
        public String getType() {
            return type;
        }

        /**
         * Sets the error type.
         *
         * @param type The error type
         */
        public void setType(String type) {
            this.type = type;
        }

        /**
         * Gets the error message.
         *
         * @return The error message
         */
        public String getMessage() {
            return message;
        }

        /**
         * Sets the error message.
         *
         * @param message The error message
         */
        public void setMessage(String message) {
            this.message = message;
        }
    }
}
