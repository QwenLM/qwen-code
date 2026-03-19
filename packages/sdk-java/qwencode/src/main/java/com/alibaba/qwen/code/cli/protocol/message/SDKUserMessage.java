package com.alibaba.qwen.code.cli.protocol.message;

import java.util.Map;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a user message in the SDK protocol.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "user")
public class SDKUserMessage extends MessageBase {
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
     * The API user message.
     */
    private final APIUserMessage message = new APIUserMessage();

    /**
     * The parent tool use ID.
     */
    @JSONField(name = "parent_tool_use_id")
    private String parentToolUseId;
    /**
     * Additional options.
     */
    private Map<String, String> options;

    /**
     * Creates a new SDKUserMessage instance and sets the type to "user".
     */
    public SDKUserMessage() {
        super();
        this.setType("user");
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
     * @return This instance for method chaining
     */
    public SDKUserMessage setSessionId(String sessionId) {
        this.sessionId = sessionId;
        return this;
    }

    /**
     * Sets the content of the message.
     *
     * @param content The content of the message
     * @return This instance for method chaining
     */
    public SDKUserMessage setContent(String content) {
        message.setContent(content);
        return this;
    }

    /**
     * Gets the content of the message.
     *
     * @return The content of the message
     */
    public String getContent() {
        return message.getContent();
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
     * @return This instance for method chaining
     */
    public SDKUserMessage setParentToolUseId(String parentToolUseId) {
        this.parentToolUseId = parentToolUseId;
        return this;
    }

    /**
     * Gets the additional options.
     *
     * @return The additional options
     */
    public Map<String, String> getOptions() {
        return options;
    }

    /**
     * Sets the additional options.
     *
     * @param options The additional options
     * @return This instance for method chaining
     */
    public SDKUserMessage setOptions(Map<String, String> options) {
        this.options = options;
        return this;
    }

    /**
     * Represents the API user message.
     */
    public static class APIUserMessage {
        /**
         * User role.
         */
        private String role = "user";
        /**
         * Message content.
         */
        private String content;

        /**
         * Gets the user role.
         *
         * @return The user role
         */
        public String getRole() {
            return role;
        }

        /**
         * Sets the user role.
         *
         * @param role The user role
         */
        public void setRole(String role) {
            this.role = role;
        }

        /**
         * Gets the message content.
         *
         * @return The message content
         */
        public String getContent() {
            return content;
        }

        /**
         * Sets the message content.
         *
         * @param content The message content
         */
        public void setContent(String content) {
            this.content = content;
        }
    }
}
