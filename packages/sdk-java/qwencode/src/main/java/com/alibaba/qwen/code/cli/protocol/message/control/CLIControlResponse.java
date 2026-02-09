package com.alibaba.qwen.code.cli.protocol.message.control;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.message.MessageBase;

/**
 * Represents a control response from the CLI.
 *
 * @param <R> The type of the response object
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "control_response")
public class CLIControlResponse<R> extends MessageBase {
    /**
     * The response object.
     */
    private Response<R> response;

    /**
     * Creates a new CLIControlResponse instance and sets the type to "control_response".
     */
    public CLIControlResponse() {
        super();
        this.type = "control_response";
    }

    /**
     * Gets the response object.
     *
     * @return The response object
     */
    public Response<R> getResponse() {
        return response;
    }

    /**
     * Sets the response object.
     *
     * @param response The response object
     */
    public void setResponse(Response<R> response) {
        this.response = response;
    }

    /**
     * Creates a new response object.
     *
     * @return A new response object
     */
    public Response<R> createResponse() {
        Response<R> response = new Response<>();
        this.setResponse(response);
        return response;
    }

    /**
     * Represents the response information.
     *
     * @param <R> The type of the response object
     */
    public static class Response<R> {
        /**
         * The ID of the request.
         */
        @JSONField(name = "request_id")
        private String requestId;
        /**
         * The subtype of the response.
         */
        private String subtype = "success";
        /**
         * The actual response.
         */
        R response;

        /**
         * Gets the ID of the request.
         *
         * @return The ID of the request
         */
        public String getRequestId() {
            return requestId;
        }

        /**
         * Sets the ID of the request.
         *
         * @param requestId The ID of the request
         * @return This instance for method chaining
         */
        public Response<R> setRequestId(String requestId) {
            this.requestId = requestId;
            return this;
        }

        /**
         * Gets the subtype of the response.
         *
         * @return The subtype of the response
         */
        public String getSubtype() {
            return subtype;
        }

        /**
         * Sets the subtype of the response.
         *
         * @param subtype The subtype of the response
         * @return This instance for method chaining
         */
        public Response<R> setSubtype(String subtype) {
            this.subtype = subtype;
            return this;
        }

        /**
         * Gets the actual response.
         *
         * @return The actual response
         */
        public R getResponse() {
            return response;
        }

        /**
         * Sets the actual response.
         *
         * @param response The actual response
         * @return This instance for method chaining
         */
        public Response<R> setResponse(R response) {
            this.response = response;
            return this;
        }
    }
}
