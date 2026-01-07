package com.alibaba.qwen.code.cli.protocol.message;

/**
 * Represents a message in the Qwen Code protocol.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public interface Message {
    /**
     * Gets the type of the message.
     *
     * @return The type of the message
     */
    String getType();

    /**
     * Gets the ID of the message.
     *
     * @return The ID of the message
     */
    String getMessageId();
}
