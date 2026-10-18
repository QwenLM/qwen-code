package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import org.springframework.http.HttpStatus;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class ManagedInputAttachments {
    static final int MAX_INPUT_BYTES = 48 * 1024;
    private static final Set<String> TEXT_EXTENSIONS = Set.of("txt", "md", "markdown", "csv", "log",
            "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "css", "scss", "js", "jsx",
            "ts", "tsx", "py", "java", "sql", "sh", "bash", "rs", "go", "c", "h", "cpp",
            "toml", "ini", "properties", "svg");
    private static final Set<String> TEXT_MIMES = Set.of("application/json", "application/xml",
            "application/javascript", "application/x-yaml", "application/yaml", "image/svg+xml");

    private ManagedInputAttachments() {}

    static Map<String, Object> normalize(InputBlock block) {
        if ("input_file".equals(block.type())) {
            String name = block.name();
            String mime = block.mimeType();
            String text = block.text();
            if (name == null || name.isBlank() || name.length() > 255
                    || name.equals(".") || name.equals("..") || name.matches("(?s).*[/\\\\\\p{Cc}].*")
                    || mime == null || !mime.matches("[a-z0-9.+-]+/[a-z0-9.+-]+")
                    || !(mime.startsWith("text/") || TEXT_MIMES.contains(mime)
                    || (mime.equals("application/octet-stream") && TEXT_EXTENSIONS.contains(
                            name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT))))
                    || text == null || text.isEmpty() || text.length() > MAX_INPUT_BYTES
                    || text.indexOf('\0') >= 0 || block.data() != null) {
                throw invalid();
            }
            String uri = "managed-input:///" + URLEncoder.encode(name, StandardCharsets.UTF_8).replace("+", "%20");
            return Map.of("type", "resource", "resource", Map.of("uri", uri, "mimeType", mime, "text", text));
        }
        if ("input_image".equals(block.type()) && block.text() == null && block.name() == null) {
            String data = block.data();
            String mime = block.mimeType();
            if (data == null || data.isEmpty() || data.length() > MAX_INPUT_BYTES || mime == null) {
                throw invalid();
            }
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(data);
            } catch (IllegalArgumentException error) {
                throw invalid();
            }
            if (!Base64.getEncoder().encodeToString(bytes).equals(data) || !imageSignature(mime, bytes)) {
                throw invalid();
            }
            return Map.of("type", "image", "data", data, "mimeType", mime);
        }
        throw invalid();
    }

    private static boolean imageSignature(String mime, byte[] bytes) {
        return switch (mime) {
            case "image/png" -> bytes.length >= 8 && Arrays.equals(Arrays.copyOf(bytes, 8),
                    new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10});
            case "image/jpeg" -> bytes.length >= 3 && bytes[0] == (byte) 255
                    && bytes[1] == (byte) 216 && bytes[2] == (byte) 255;
            case "image/webp" -> bytes.length >= 12 && new String(bytes, 0, 4, StandardCharsets.US_ASCII).equals("RIFF")
                    && new String(bytes, 8, 4, StandardCharsets.US_ASCII).equals("WEBP");
            default -> false;
        };
    }

    private static ApiException invalid() {
        return new ApiException(HttpStatus.BAD_REQUEST, "unsupported_input",
                "Attachments require a UTF-8 text file or a valid PNG, JPEG or WebP image; URLs and host paths are unsupported.");
    }
}
