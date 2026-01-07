package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a control interrupt request to the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "interrupt")
public class CLIControlInterruptRequest extends ControlRequestPayload {
    public CLIControlInterruptRequest() {
        super();
        setSubtype("interrupt");
    }
}
