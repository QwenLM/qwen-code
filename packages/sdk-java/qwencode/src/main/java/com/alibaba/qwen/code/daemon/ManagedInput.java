package com.alibaba.qwen.code.daemon;

import java.util.Base64;
import java.util.Map;

/** One initial or subsequent Managed Turn input block. */
public final class ManagedInput {
    private final Map<String, Object> json;

    private ManagedInput(Map<String, Object> json) {
        this.json = json;
    }

    public static ManagedInput text(String text) {
        return new ManagedInput(Map.of("type", "input_text", "text", text));
    }

    /** A text file attachment for a Session with input attachments enabled. */
    public static ManagedInput file(String name, String mimeType, String text) {
        return new ManagedInput(Map.of("type", "input_file", "name", name, "mime_type", mimeType, "text", text));
    }

    /** An image attachment for a Session with input attachments enabled. */
    public static ManagedInput image(String mimeType, byte[] content) {
        return new ManagedInput(Map.of("type", "input_image", "mime_type", mimeType,
                "data", Base64.getEncoder().encodeToString(content)));
    }

    Map<String, Object> toJson() {
        return json;
    }
}
