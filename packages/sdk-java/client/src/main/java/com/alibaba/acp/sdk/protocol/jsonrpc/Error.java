package com.alibaba.acp.sdk.protocol.jsonrpc;

import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Represents an error in the JSON-RPC protocol.
 *
 * This class encapsulates error information including code, message, and optional data
 * that can be returned to clients when errors occur during RPC processing.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class Error {
    private int code;
    private String message;
    private Object data;

    /**
     * Constructs a new Error with the specified code, message, and data.
     *
     * @param code The error code
     * @param message The error message
     * @param data Additional error data
     */
    public Error(int code, String message, Object data) {
        this.code = code;
        this.message = message;
        this.data = data;
    }

    /**
     * Constructs a new Error with default values.
     */
    public Error() {
    }

    /**
     * Gets the error code.
     *
     * @return The error code
     */
    public int getCode() {
        return code;
    }

    /**
     * Sets the error code.
     *
     * @param code The error code
     * @return This error instance for method chaining
     */
    public Error setCode(int code) {
        this.code = code;
        return this;
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
     * @return This error instance for method chaining
     */
    public Error setMessage(String message) {
        this.message = message;
        return this;
    }

    /**
     * Gets the error data.
     *
     * @return The error data
     */
    public Object getData() {
        return data;
    }

    /**
     * Sets the error data.
     *
     * @param data The error data
     * @return This error instance for method chaining
     */
    public Error setData(Object data) {
        this.data = data;
        return this;
    }

    /**
     * Enum representing standard error codes in the JSON-RPC protocol.
     *
     * These codes follow the JSON-RPC 2.0 specification with additional custom codes
     * for ACP-specific error conditions.
     */
    public enum ErrorCode {
        /**
         * Parse error: Invalid JSON was received by the server.
         * An error occurred on the server while parsing the JSON text.
         */
        PARSE_ERROR(-32700, "**Parse error**: Invalid JSON was received by the server.\nAn error occurred on the server while parsing the JSON text."),

        /**
         * Invalid request: The JSON sent is not a valid Request object.
         */
        INVALID_REQUEST(-32600, "**Invalid request**: The JSON sent is not a valid Request object."),

        /**
         * Method not found: The method does not exist or is not available.
         */
        METHOD_NOT_FOUND(-32601, "**Method not found**: The method does not exist or is not available."),

        /**
         * Invalid params: Invalid method parameter(s).
         */
        INVALID_PARAMS(-32602, "**Invalid params**: Invalid method parameter(s)."),

        /**
         * Internal error: Internal JSON-RPC error.
         * Reserved for implementation-defined server errors.
         */
        INTERNAL_ERROR(-32603, "**Internal error**: Internal JSON-RPC error.\nReserved for implementation-defined server errors."),

        /**
         * Authentication required: Authentication is required before this operation can be performed.
         */
        AUTHENTICATION_REQUIRED(-32000, "**Authentication required**: Authentication is required before this operation can be performed."),

        /**
         * Resource not found: A given resource, such as a file, was not found.
         */
        RESOURCE_NOT_FOUND(-32002, "**Resource not found**: A given resource, such as a file, was not found."),

        /**
         * Other undefined error code.
         */
        OTHER_UNDEFINED_ERROR(-32004, "Other undefined error code.");

        private final int code;
        private final String description;

        /**
         * Constructs a new ErrorCode with the specified code and description.
         *
         * @param code The error code
         * @param description The error description
         */
        ErrorCode(int code, String description) {
            this.code = code;
            this.description = description;
        }

        /**
         * Gets the error code.
         *
         * @return The error code
         */
        @JSONField
        public int getCode() {
            return code;
        }

        /**
         * Gets the error description.
         *
         * @return The error description
         */
        @JSONField(deserialize = false)
        public String getDescription() {
            return description;
        }
    }
}
