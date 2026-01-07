package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Base class for stream events during message streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "StreamEvent",
        seeAlso = {MessageStartStreamEvent.class, MessageStopStreamEvent.class, ContentBlockStartEvent.class, ContentBlockStopEvent.class,
                ContentBlockDeltaEvent.class})
public class StreamEvent {
    /**
     * The type of the stream event.
     */
    protected String type;

    /**
     * Gets the type of the stream event.
     *
     * @return The type of the stream event
     */
    public String getType() {
        return type;
    }

    /**
     * Sets the type of the stream event.
     *
     * @param type The type of the stream event
     */
    public void setType(String type) {
        this.type = type;
    }
}
