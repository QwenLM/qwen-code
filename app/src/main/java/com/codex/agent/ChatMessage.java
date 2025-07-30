package com.codex.agent;

public class ChatMessage {
    public enum Type {
        USER,
        BOT,
        ERROR
    }

    private String message;
    private Type type;

    public ChatMessage(String message, Type type) {
        this.message = message;
        this.type = type;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public void appendMessage(String message) {
        this.message += message;
    }

    public Type getType() {
        return type;
    }

    public void setType(Type type) {
        this.type = type;
    }
}
