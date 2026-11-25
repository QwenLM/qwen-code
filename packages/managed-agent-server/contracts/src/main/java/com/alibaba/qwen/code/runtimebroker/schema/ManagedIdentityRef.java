package com.alibaba.qwen.code.runtimebroker.schema;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Reversible ASCII encoding for a bounded identity tuple. */
public final class ManagedIdentityRef {
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    private ManagedIdentityRef() {
    }

    public static byte[] encode(int maximumBytes, String... components) {
        if (maximumBytes <= 0 || components == null || components.length == 0) {
            throw new IllegalArgumentException(
                    "a positive byte budget and identity components are required");
        }
        StringBuilder encoded = new StringBuilder("v1|")
                .append(components.length).append('|');
        for (int index = 0; index < components.length; index++) {
            if (index > 0) {
                encoded.append('|');
            }
            String component = components[index];
            if (component == null) {
                encoded.append('-');
                continue;
            }
            byte[] bytes = ManagedSchemaKeys.identity(component);
            encoded.append(bytes.length).append(':');
            for (byte value : bytes) {
                int octet = value & 0xff;
                if (unreserved(octet)) {
                    encoded.append((char) octet);
                } else {
                    encoded.append('%').append(HEX[octet >>> 4])
                            .append(HEX[octet & 0x0f]);
                }
            }
        }
        byte[] result = encoded.toString().getBytes(StandardCharsets.US_ASCII);
        if (result.length > maximumBytes) {
            throw new IllegalArgumentException(
                    "identity reference exceeds its byte budget");
        }
        return result;
    }

    public static List<String> decode(byte[] bytes) {
        if (bytes == null) {
            throw new IllegalArgumentException("identity reference is required");
        }
        String text = new String(bytes, StandardCharsets.UTF_8);
        String[] parts = text.split("\\|", -1);
        if (parts.length < 3 || !"v1".equals(parts[0])) {
            throw new IllegalArgumentException("invalid identity reference header");
        }
        int count = integer(parts[1]);
        if (count < 1 || parts.length != count + 2) {
            throw new IllegalArgumentException("invalid identity reference arity");
        }
        List<String> components = new ArrayList<>(count);
        for (int index = 2; index < parts.length; index++) {
            String part = parts[index];
            if ("-".equals(part)) {
                components.add(null);
                continue;
            }
            int separator = part.indexOf(':');
            if (separator < 1) {
                throw new IllegalArgumentException("invalid identity reference component");
            }
            int length = integer(part.substring(0, separator));
            byte[] value = percentDecode(part.substring(separator + 1));
            if (value.length != length) {
                throw new IllegalArgumentException("identity reference length mismatch");
            }
            String component = new String(value, StandardCharsets.UTF_8);
            if (!Arrays.equals(value, component.getBytes(StandardCharsets.UTF_8))) {
                throw new IllegalArgumentException("identity reference is not valid UTF-8");
            }
            components.add(component);
        }
        if (!Arrays.equals(bytes,
                encode(Integer.MAX_VALUE, components.toArray(String[]::new)))) {
            throw new IllegalArgumentException("identity reference is not canonical");
        }
        return Collections.unmodifiableList(components);
    }

    private static int integer(String value) {
        if (value.isEmpty() || value.chars().anyMatch(character ->
                character < '0' || character > '9')) {
            throw new IllegalArgumentException("invalid identity reference length");
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("identity reference length overflow", error);
        }
    }

    private static byte[] percentDecode(String value) {
        ByteArrayOutputStream decoded = new ByteArrayOutputStream();
        for (int index = 0; index < value.length();) {
            char character = value.charAt(index);
            if (character == '%') {
                if (index + 2 >= value.length()) {
                    throw new IllegalArgumentException("truncated identity reference escape");
                }
                decoded.write((hex(value.charAt(index + 1)) << 4)
                        | hex(value.charAt(index + 2)));
                index += 3;
            } else {
                if (!unreserved(character)) {
                    throw new IllegalArgumentException("invalid identity reference escape");
                }
                decoded.write(character);
                index++;
            }
        }
        return decoded.toByteArray();
    }

    private static int hex(char value) {
        int digit = Character.digit(value, 16);
        if (digit < 0 || (value >= 'a' && value <= 'f')) {
            throw new IllegalArgumentException("identity reference escapes must be uppercase");
        }
        return digit;
    }

    private static boolean unreserved(int value) {
        return value >= 'a' && value <= 'z'
                || value >= 'A' && value <= 'Z'
                || value >= '0' && value <= '9'
                || value == '.' || value == '_' || value == '~'
                || value == ':' || value == '-';
    }
}
