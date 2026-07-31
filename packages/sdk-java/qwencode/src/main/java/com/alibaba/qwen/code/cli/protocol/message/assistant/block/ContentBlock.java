package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import java.util.List;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent;

/**
 * Abstract base class for content blocks in assistant messages.
 *
 * @param <C> The type of content
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "ContentBlock", seeAlso = { TextBlock.class, ToolResultBlock.class, ThinkingBlock.class, ToolUseBlock.class })
public abstract class ContentBlock<C> implements AssistantContent<C> {
    /**
     * The type of the content block.
     */
    protected String type;
    /**
     * List of annotations.
     */
    protected List<Annotation> annotations;
    /**
     * The message ID.
     */
    protected String messageId;

    /** {@inheritDoc} */
    @Override
    public String getType() {
        return type;
    }

    /**
     * Sets the type of the content block.
     *
     * @param type The type of the content block
     */
    public void setType(String type) {
        this.type = type;
    }

    /**
     * Gets the list of annotations.
     *
     * @return The list of annotations
     */
    public List<Annotation> getAnnotations() {
        return annotations;
    }

    /**
     * Sets the list of annotations.
     *
     * @param annotations The list of annotations
     */
    public void setAnnotations(List<Annotation> annotations) {
        this.annotations = annotations;
    }

    /** {@inheritDoc} */
    @Override
    public String getMessageId() {
        return messageId;
    }

    /**
     * Sets the message ID.
     *
     * @param messageId The message ID
     */
    public void setMessageId(String messageId) {
        this.messageId = messageId;
    }

    /**
     * <p>toString.</p>
     *
     * @return a {@link java.lang.String} object.
     */
    public String toString() {
        return JSON.toJSONString(this);
    }
}
