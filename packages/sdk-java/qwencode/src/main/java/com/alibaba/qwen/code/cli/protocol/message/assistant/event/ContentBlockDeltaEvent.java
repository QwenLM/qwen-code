package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import java.util.Map;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.TypeReference;
import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ThingkingAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolUseAssistantContent;

/**
 * Represents a content block delta event during streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "content_block_delta")
public class ContentBlockDeltaEvent extends StreamEvent {
    /**
     * The index of the content block.
     */
    private int index;
    /**
     * The content block delta.
     */
    private ContentBlockDelta<?> delta;

    /**
     * Gets the index of the content block.
     *
     * @return The index of the content block
     */
    public int getIndex() {
        return index;
    }

    /**
     * Sets the index of the content block.
     *
     * @param index The index of the content block
     */
    public void setIndex(int index) {
        this.index = index;
    }

    /**
     * Gets the content block delta.
     *
     * @return The content block delta
     */
    public ContentBlockDelta<?> getDelta() {
        return delta;
    }

    /**
     * Sets the content block delta.
     *
     * @param delta The content block delta
     */
    public void setDelta(ContentBlockDelta<?> delta) {
        this.delta = delta;
    }

    /**
     * Abstract base class for content block deltas.
     *
     * @param <C> The type of content
     */
    @JSONType(typeKey = "type", typeName = "ContentBlockDelta",
            seeAlso = {ContentBlockDeltaText.class, ContentBlockDeltaThinking.class, ContentBlockDeltaInputJson.class})
    public abstract static class ContentBlockDelta<C> implements AssistantContent<C> {
        /**
         * The type of the content block delta.
         */
        protected String type;
        /**
         * The message ID.
         */
        protected String messageId;

        @Override
        public String getType() {
            return type;
        }

        /**
         * Sets the type of the content block delta.
         *
         * @param type The type of the content block delta
         */
        public void setType(String type) {
            this.type = type;
        }

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

        public String toString() {
            return JSON.toJSONString(this);
        }
    }

    /**
     * Represents a text delta.
     */
    @JSONType(typeKey = "type", typeName = "text_delta")
    public static class ContentBlockDeltaText extends ContentBlockDelta<String> implements TextAssistantContent {
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

        @Override
        public String getContentOfAssistant() {
            return text;
        }
    }

    /**
     * Represents a thinking delta.
     */
    @JSONType(typeKey = "type", typeName = "thinking_delta")
    public static class ContentBlockDeltaThinking extends ContentBlockDelta<String> implements ThingkingAssistantContent {
        /**
         * The thinking content.
         */
        private String thinking;

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

        @Override
        public String getContentOfAssistant() {
            return thinking;
        }
    }

    /**
     * Represents an input JSON delta.
     */
    @JSONType(typeKey = "type", typeName = "input_json_delta")
    public static class ContentBlockDeltaInputJson extends ContentBlockDelta<Map<String, Object>> implements ToolUseAssistantContent {
        /**
         * The partial JSON content.
         */
        @JSONField(name = "partial_json")
        private String partialJson;

        /**
         * Gets the partial JSON content.
         *
         * @return The partial JSON content
         */
        public String getPartialJson() {
            return partialJson;
        }

        /**
         * Sets the partial JSON content.
         *
         * @param partialJson The partial JSON content
         */
        public void setPartialJson(String partialJson) {
            this.partialJson = partialJson;
        }

        @Override
        public Map<String, Object> getContentOfAssistant() {
            return getInput();
        }

        @Override
        public Map<String, Object> getInput() {
            return JSON.parseObject(partialJson, new TypeReference<Map<String, Object>>() {});
        }
    }
}
