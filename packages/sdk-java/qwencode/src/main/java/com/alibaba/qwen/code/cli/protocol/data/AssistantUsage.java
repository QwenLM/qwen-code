package com.alibaba.qwen.code.cli.protocol.data;

import com.alibaba.fastjson2.JSON;

/**
 * Represents usage information for an assistant message.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class AssistantUsage {
    /**
     * The ID of the message.
     */
    String messageId;
    /**
     * The usage information.
     */
    Usage usage;

    /**
     * Gets the message ID.
     *
     * @return The message ID
     */
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
     * Gets the usage information.
     *
     * @return The usage information
     */
    public Usage getUsage() {
        return usage;
    }

    /**
     * Sets the usage information.
     *
     * @param usage The usage information
     */
    public void setUsage(Usage usage) {
        this.usage = usage;
    }

    /**
     * Constructs a new AssistantUsage instance.
     *
     * @param messageId The message ID
     * @param usage The usage information
     */
    public AssistantUsage(String messageId, Usage usage) {
        this.messageId = messageId;
        this.usage = usage;
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
