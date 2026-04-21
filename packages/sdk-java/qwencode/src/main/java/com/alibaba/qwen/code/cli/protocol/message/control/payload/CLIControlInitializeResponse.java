package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.Capabilities;

/**
 * Represents a control initialize response from the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "initialize")
public class CLIControlInitializeResponse extends ControlResponsePayload {
    public CLIControlInitializeResponse() {
        super();
        this.subtype = "initialize";
    }

    /**
     * The capabilities' information.
     */
    Capabilities capabilities;

    /**
     * Gets the capabilities information.
     *
     * @return The capabilities information
     */
    public Capabilities getCapabilities() {
        return capabilities;
    }

    /**
     * Sets the capabilities information.
     *
     * @param capabilities The capabilities information
     */
    public void setCapabilities(Capabilities capabilities) {
        this.capabilities = capabilities;
    }
}
