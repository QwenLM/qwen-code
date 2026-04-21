package com.alibaba.qwen.code.cli.protocol.data.behavior;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a deny behavior that rejects an operation.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "operation", typeName = "deny")
public class Deny extends Behavior {
    /**
     * Creates a new Deny instance and sets the behavior to deny.
     */
    public Deny() {
        super();
        this.behavior = Operation.deny;
    }

    /**
     * The message explaining why the operation was denied.
     */
    String message;

    /**
     * Gets the denial message.
     *
     * @return The denial message
     */
    public String getMessage() {
        return message;
    }

    /**
     * Sets the denial message.
     *
     * @param message The denial message
     * @return This instance for method chaining
     */
    public Deny setMessage(String message) {
        this.message = message;
        return this;
    }
}
