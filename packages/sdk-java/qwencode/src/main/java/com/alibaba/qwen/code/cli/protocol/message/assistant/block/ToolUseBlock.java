package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import java.util.Collections;
import java.util.List;
import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolUseAssistantContent;

/**
 * Represents a tool use content block.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "tool_use")
public class ToolUseBlock extends ContentBlock<Map<String, Object>> implements ToolUseAssistantContent {
    /**
     * The tool use ID.
     */
    private String id;
    /**
     * The tool name.
     */
    private String name;
    /**
     * The tool input.
     */
    private Map<String, Object> input;
    /**
     * List of annotations.
     */
    private List<Annotation> annotations;

    /**
     * Creates a new ToolUseBlock instance.
     */
    public ToolUseBlock() {}

    /**
     * Gets the tool use ID.
     *
     * @return The tool use ID
     */
    public String getId() {
        return id;
    }

    /**
     * Sets the tool use ID.
     *
     * @param id The tool use ID
     */
    public void setId(String id) {
        this.id = id;
    }

    /**
     * Gets the tool name.
     *
     * @return The tool name
     */
    public String getName() {
        return name;
    }

    /**
     * Sets the tool name.
     *
     * @param name The tool name
     */
    public void setName(String name) {
        this.name = name;
    }

    /**
     * Gets the tool input.
     *
     * @return The tool input
     */
    public Map<String, Object> getInput() {
        return input;
    }

    /**
     * Sets the tool input.
     *
     * @param input The tool input
     */
    public void setInput(Map<String, Object> input) {
        this.input = input;
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
     * {@inheritDoc}
     *
     * Sets the list of annotations.
     */
    @Override
    public void setAnnotations(List<Annotation> annotations) {
        this.annotations = annotations;
    }

    /**
     * {@inheritDoc}
     *
     * Gets the content of the assistant.
     */
    @Override
    public Map<String, Object> getContentOfAssistant() {
        return Collections.emptyMap();
    }
}
