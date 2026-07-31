package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a message start event during message streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeName = "message_start")
public class MessageStartStreamEvent extends StreamEvent{
    /**
     * The message that is starting.
     */
    private Message message;

    /**
     * Represents the message information.
     */
    public static class Message {
        /**
         * Message ID.
         */
        private String id;
        /**
         * Message role.
         */
        private String role;
        /**
         * Message model.
         */
        private String model;

        /**
         * Gets the message ID.
         *
         * @return The message ID
         */
        public String getId() {
            return id;
        }

        /**
         * Sets the message ID.
         *
         * @param id The message ID
         */
        public void setId(String id) {
            this.id = id;
        }

        /**
         * Gets the message role.
         *
         * @return The message role
         */
        public String getRole() {
            return role;
        }

        /**
         * Sets the message role.
         *
         * @param role The message role
         */
        public void setRole(String role) {
            this.role = role;
        }

        /**
         * Gets the message model.
         *
         * @return The message model
         */
        public String getModel() {
            return model;
        }

        /**
         * Sets the message model.
         *
         * @param model The message model
         */
        public void setModel(String model) {
            this.model = model;
        }
    }

    /**
     * Gets the message that is starting.
     *
     * @return The message that is starting
     */
    public Message getMessage() {
        return message;
    }

    /**
     * Sets the message that is starting.
     *
     * @param message The message that is starting
     */
    public void setMessage(Message message) {
        this.message = message;
    }
}
