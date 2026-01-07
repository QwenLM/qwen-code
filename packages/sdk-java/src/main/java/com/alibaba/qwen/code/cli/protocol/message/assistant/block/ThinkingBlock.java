package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ThingkingAssistantContent;

/**
 * Represents a thinking content block.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "thinking")
public class ThinkingBlock extends ContentBlock<String> implements ThingkingAssistantContent {
    /**
     * The thinking content.
     */
    private String thinking;
    /**
     * The signature.
     */
    private String signature;

    /**
     * Gets the thinking content.
     *
     * @return The thinking content
     */
    public String getThinking() {
        return thinking;
    }

    /**
     * Sets the thinking content.
     *
     * @param thinking The thinking content
     */
    public void setThinking(String thinking) {
        this.thinking = thinking;
    }

    /**
     * Gets the signature.
     *
     * @return The signature
     */
    public String getSignature() {
        return signature;
    }

    /**
     * Sets the signature.
     *
     * @param signature The signature
     */
    public void setSignature(String signature) {
        this.signature = signature;
    }

    /** {@inheritDoc} */
    @Override
    public String getContentOfAssistant() {
        return thinking;
    }
}
