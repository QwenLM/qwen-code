package com.alibaba.qwen.code.cli.protocol.message.assistant;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.message.MessageBase;

/**
 * Represents an SDK assistant message.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "assistant")
public class SDKAssistantMessage extends MessageBase {
    /**
     * The UUID of the message.
     */
    private String uuid;

    /**
     * The session ID.
     */
    @JSONField(name = "session_id")
    private String sessionId;
    /**
     * The API assistant message.
     */
    private APIAssistantMessage message;

    /**
     * The parent tool use ID.
     */
    @JSONField(name = "parent_tool_use_id")
    private String parentToolUseId;

    /**
     * Creates a new SDKAssistantMessage instance and sets the type to "assistant".
     */
    public SDKAssistantMessage() {
        super();
        this.type = "assistant";
    }

    /** {@inheritDoc} */
    @Override
    public String getMessageId() {
        return this.getUuid();
    }

    /**
     * Gets the UUID of the message.
     *
     * @return The UUID of the message
     */
    public String getUuid() {
        return uuid;
    }

    /**
     * Sets the UUID of the message.
     *
     * @param uuid The UUID of the message
     */
    public void setUuid(String uuid) {
        this.uuid = uuid;
    }

    /**
     * Gets the session ID.
     *
     * @return The session ID
     */
    public String getSessionId() {
        return sessionId;
    }

    /**
     * Sets the session ID.
     *
     * @param sessionId The session ID
     */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    /**
     * Gets the API assistant message.
     *
     * @return The API assistant message
     */
    public APIAssistantMessage getMessage() {
        return message;
    }

    /**
     * Sets the API assistant message.
     *
     * @param message The API assistant message
     */
    public void setMessage(APIAssistantMessage message) {
        this.message = message;
    }

    /**
     * Gets the parent tool use ID.
     *
     * @return The parent tool use ID
     */
    public String getParentToolUseId() {
        return parentToolUseId;
    }

    /**
     * Sets the parent tool use ID.
     *
     * @param parentToolUseId The parent tool use ID
     */
    public void setParentToolUseId(String parentToolUseId) {
        this.parentToolUseId = parentToolUseId;
    }
}
