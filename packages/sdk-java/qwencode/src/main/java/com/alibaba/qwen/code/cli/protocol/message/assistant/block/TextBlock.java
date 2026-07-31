package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;

/**
 * Represents a text content block.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "text")
public class TextBlock extends ContentBlock<String> implements TextAssistantContent {
    /**
     * The text content.
     */
    private String text;

    /**
     * Gets the text content.
     *
     * @return The text content
     */
    public String getText() {
        return text;
    }

    /**
     * Sets the text content.
     *
     * @param text The text content
     */
    public void setText(String text) {
        this.text = text;
    }

    /** {@inheritDoc} */
    @Override
    public String getContentOfAssistant() {
        return text;
    }
}
