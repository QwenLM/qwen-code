package com.alibaba.qwen.code.cli.protocol.message.control;

import java.util.UUID;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.message.MessageBase;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;

/**
 * Represents a control request to the CLI.
 *
 * @param <R> The type of the request object
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "control_request")
public class CLIControlRequest<R extends ControlRequestPayload> extends MessageBase {
    /**
     * The ID of the request.
     */
    @JSONField(name = "request_id")
    private String requestId = UUID.randomUUID().toString();

    /**
     * The actual request object.
     */
    private R request;

    /**
     * Creates a new CLIControlRequest instance and sets the type to "control_request".
     */
    public CLIControlRequest() {
        super();
        type = "control_request";
    }

    /**
     * Creates a new control request with the specified request object.
     *
     * @param request The request object
     * @param <T> The type of the request object
     * @return A new control request instance
     */
    public static <T extends ControlRequestPayload> CLIControlRequest<T> create(T request) {
        CLIControlRequest<T> controlRequest = new CLIControlRequest<>();
        controlRequest.setRequest(request);
        return controlRequest;
    }

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
    public CLIControlRequest<R> setRequestId(String requestId) {
        this.requestId = requestId;
        return this;
    }

    /**
     * Gets the actual request object.
     *
     * @return The actual request object
     */
    public R getRequest() {
        return request;
    }

    /**
     * Sets the actual request object.
     *
     * @param request The actual request object
     * @return This instance for method chaining
     */
    public CLIControlRequest<R> setRequest(R request) {
        this.request = request;
        return this;
    }
}
