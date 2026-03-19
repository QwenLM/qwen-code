package com.alibaba.qwen.code.cli.protocol.message.control.payload;

/**
 * Represents a control response for setting the model in the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class CLIControlSetModelResponse {
    /**
     * The subtype of the response ("set_model").
     */
    String subtype = "set_model";
    /**
     * The model that was set.
     */
    String model;

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
     */
    public void setSubtype(String subtype) {
        this.subtype = subtype;
    }

    /**
     * Gets the model that was set.
     *
     * @return The model that was set
     */
    public String getModel() {
        return model;
    }

    /**
     * Sets the model that was set.
     *
     * @param model The model that was set
     */
    public void setModel(String model) {
        this.model = model;
    }
}
