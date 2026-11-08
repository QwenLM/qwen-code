package com.alibaba.qwen.code.managedagent.persistence;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Length-prefixed byte encoding and digest helpers, split out of
 * WorkspaceCsiApplicationInventory. The encoding layout, null handling and
 * digest spellings are the ones the inventory used inline.
 */
final class WorkspaceCsiInventoryCodec {
    private WorkspaceCsiInventoryCodec() { }

    @FunctionalInterface
    interface Encoder { void write(DataOutputStream out) throws IOException; }

    static byte[] encode(Encoder encoder) {
        try {
            var bytes = new ByteArrayOutputStream();
            try (var output = new DataOutputStream(bytes)) {
                encoder.write(output);
            }
            return bytes.toByteArray();
        } catch (IOException exception) {
            throw new IllegalStateException("Inventory encoding failed", exception);
        }
    }

    static void write(DataOutputStream output, String value) throws IOException {
        write(output, value == null ? null : utf8(value));
    }

    static void write(DataOutputStream output, byte[] bytes) throws IOException {
        output.writeInt(bytes == null ? -1 : bytes.length);
        if (bytes != null) {
            output.write(bytes);
        }
    }

    static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    static String digest(String... values) {
        return hash(encode(out -> {
            for (String value : values) {
                write(out, value);
            }
        }));
    }

    static String hash(byte[] bytes) {
        return org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes);
    }
}
