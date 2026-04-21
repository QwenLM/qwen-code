package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.message.assistant.block.ContentBlock;

/**
 * Represents a content block start event during message streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "content_block_start")
public class ContentBlockStartEvent extends StreamEvent{
    /**
     * The index of the content block.
     */
    private int index;

    /**
     * The content block that is starting.
     */
    @JSONField(name = "content_block")
    private ContentBlock contentBlock;
}
