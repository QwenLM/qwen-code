package com.example.qwencode;

public class ChatMessage {
    public enum Type {
        USER,
        BOT
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
