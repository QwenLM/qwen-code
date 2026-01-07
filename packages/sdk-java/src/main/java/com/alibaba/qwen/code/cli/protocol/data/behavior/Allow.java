package com.alibaba.qwen.code.cli.protocol.data.behavior;

import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents an allow behavior that permits an operation.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "operation", typeName = "allow")
public class Allow extends Behavior {
    /**
     * Creates a new Allow instance and sets the behavior to allow.
     */
    public Allow() {
        super();
        this.behavior = Operation.allow;
    }
    /**
     * Updated input for the operation.
     */
    Map<String, Object> updatedInput;

    /**
     * Gets the updated input.
     *
     * @return The updated input
     */
    public Map<String, Object> getUpdatedInput() {
        return updatedInput;
    }

    /**
     * Sets the updated input.
     *
     * @param updatedInput The updated input
     * @return This instance for method chaining
     */
    public Allow setUpdatedInput(Map<String, Object> updatedInput) {
        this.updatedInput = updatedInput;
        return this;
    }
}
