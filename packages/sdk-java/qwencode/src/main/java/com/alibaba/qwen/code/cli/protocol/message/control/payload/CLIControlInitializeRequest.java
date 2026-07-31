package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.InitializeConfig;

/**
 * Represents a control initialize request to the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "initialize")
public class CLIControlInitializeRequest extends ControlRequestPayload {
    public CLIControlInitializeRequest() {
        super();
        this.subtype = "initialize";
    }

    /**
     * The initialization configuration.
     */
    @JSONField(unwrapped = true)
    InitializeConfig initializeConfig = new InitializeConfig();

    /**
     * Gets the initialization configuration.
     *
     * @return The initialization configuration
     */
    public InitializeConfig getInitializeConfig() {
        return initializeConfig;
    }

    /**
     * Sets the initialization configuration.
     *
     * @param initializeConfig The initialization configuration
     * @return This instance for method chaining
     */
    public CLIControlInitializeRequest setInitializeConfig(InitializeConfig initializeConfig) {
        this.initializeConfig = initializeConfig;
        return this;
    }
}
