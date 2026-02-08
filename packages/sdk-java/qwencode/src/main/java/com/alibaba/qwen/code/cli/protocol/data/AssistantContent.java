package com.alibaba.qwen.code.cli.protocol.data;

import java.util.Map;

/**
 * Represents content from the assistant in a Qwen Code session.
 *
 * @param <C> The type of content
 * @author skyfire
 * @version $Id: 0.0.1
 */
public interface AssistantContent<C> {
    /**
     * Gets the type of the assistant content.
     *
     * @return The type of the assistant content
     */
    String getType();

    /**
     * Gets the actual content from the assistant.
     *
     * @return The content from the assistant
     */
    C getContentOfAssistant();

    /**
     * Gets the message ID associated with this content.
     *
     * @return The message ID
     */
    String getMessageId();

    /**
     * Represents text content from the assistant.
     */
    interface TextAssistantContent extends AssistantContent<String> {
        /**
         * Gets the text content.
         *
         * @return The text content
         */
        String getText();
    }

    /**
     * Represents thinking content from the assistant.
     */
    interface ThingkingAssistantContent extends AssistantContent<String> {
        /**
         * Gets the thinking content.
         *
         * @return The thinking content
         */
        String getThinking();
    }

    /**
     * Represents tool use content from the assistant.
     */
    interface ToolUseAssistantContent extends AssistantContent<Map<String, Object>> {
        /**
         * Gets the tool input.
         *
         * @return The tool input
         */
        Map<String, Object> getInput();
    }

    /**
     * Represents tool result content from the assistant.
     */
    interface ToolResultAssistantContent extends AssistantContent<String> {
        /**
         * Gets whether the tool result indicates an error.
         *
         * @return Whether the tool result indicates an error
         */
        Boolean getIsError();

        /**
         * Gets the tool result content.
         *
         * @return The tool result content
         */
        String getContent();

        /**
         * Gets the tool use ID.
         *
         * @return The tool use ID
         */
        String getToolUseId();
    }
}
