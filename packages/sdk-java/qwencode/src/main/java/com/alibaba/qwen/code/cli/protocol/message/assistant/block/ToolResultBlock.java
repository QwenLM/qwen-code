package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolResultAssistantContent;

/**
 * Represents a tool result content block.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "tool_result")
public class ToolResultBlock extends ContentBlock<String> implements ToolResultAssistantContent {
    /**
     * The tool use ID.
     */
    @JSONField(name = "tool_use_id")
    private String toolUseId;

    /**
     * The result content.
     */
    @JSONField(name = "content")
    private String content;

    /**
     * Whether the result is an error.
     */
    @JSONField(name = "is_error")
    private Boolean isError;

    /**
     * Gets the tool use ID.
     *
     * @return The tool use ID
     */
    public String getToolUseId() {
        return toolUseId;
    }

    /**
     * Sets the tool use ID.
     *
     * @param toolUseId The tool use ID
     */
    public void setToolUseId(String toolUseId) {
        this.toolUseId = toolUseId;
    }

    /**
     * Gets the result content.
     *
     * @return The result content
     */
    public String getContent() {
        return content;
    }

    /**
     * Sets the result content.
     *
     * @param content The result content
     */
    public void setContent(String content) {
        this.content = content;
    }

    /**
     * Gets whether the result is an error.
     *
     * @return Whether the result is an error
     */
    public Boolean getIsError() {
        return isError;
    }

    /**
     * Sets whether the result is an error.
     *
     * @param isError Whether the result is an error
     */
    public void setIsError(Boolean isError) {
        this.isError = isError;
    }

    /** {@inheritDoc} */
    @Override
    public String getContentOfAssistant() {
        return content;
    }
}
