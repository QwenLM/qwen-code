package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a content block stop event during message streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "content_block_stop")
public class ContentBlockStopEvent extends StreamEvent{
    /**
     * The index of the content block.
     */
    Long index;

    /**
     * Gets the index of the content block.
     *
     * @return The index of the content block
     */
    public Long getIndex() {
        return index;
    }

    /**
     * Sets the index of the content block.
     *
     * @param index The index of the content block
     */
    public void setIndex(Long index) {
        this.index = index;
    }
}
