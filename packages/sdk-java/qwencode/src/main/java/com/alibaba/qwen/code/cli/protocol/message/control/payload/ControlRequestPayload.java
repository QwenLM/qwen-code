package com.alibaba.qwen.code.cli.protocol.message.control.payload;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a payload request in the CLI control message.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "subtype", typeName = "ControlRequestPayload",
        seeAlso = {CLIControlInitializeRequest.class, CLIControlInterruptRequest.class, CLIControlPermissionRequest.class, CLIControlSetModelRequest.class, CLIControlSetPermissionModeRequest.class})
public class ControlRequestPayload {
    /**
     * The subtype of the request.
     */
    protected String subtype;

    public String getSubtype() {
        return subtype;
    }

    public void setSubtype(String subtype) {
        this.subtype = subtype;
    }
}
