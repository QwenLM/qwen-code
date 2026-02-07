package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a control request to set the model in the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "set_model")
public class CLIControlSetModelRequest extends ControlRequestPayload {
    public CLIControlSetModelRequest() {
        super();
        this.subtype = "set_model";
    }

    /**
     * The model to set.
     */
    String model;

    /**
     * Gets the model to set.
     *
     * @return The model to set
     */
    public String getModel() {
        return model;
    }

    /**
     * Sets the model to set.
     *
     * @param model The model to set
     */
    public void setModel(String model) {
        this.model = model;
    }
}
