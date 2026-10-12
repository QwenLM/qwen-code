package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.util.regex.Pattern;

final class WorkspaceValues {
    static final int MAXIMUM_TEXT_CODE_POINTS = 512;

    private static final Pattern IDENTIFIER = Pattern.compile(
            "[A-Za-z0-9._:-]{1,128}");

    private WorkspaceValues() {
    }

    static boolean isIdentifier(String value) {
        return value != null && IDENTIFIER.matcher(value).matches();
    }

    static String requireIdentifier(String value, String name) {
        if (!isIdentifier(value)) {
            throw new IllegalArgumentException(name
                    + " must match [A-Za-z0-9._:-]{1,128}");
        }
        return value;
    }

    static String requirePrintableAscii(String value, String name,
            int maximumLength) {
        boolean valid = value != null && !value.isEmpty()
                && value.length() <= maximumLength;
        for (int index = 0; valid && index < value.length(); index++) {
            char character = value.charAt(index);
            valid = character >= 0x21 && character <= 0x7E;
        }
        if (!valid) {
            throw new IllegalArgumentException(name + " must be 1 to "
                    + maximumLength + " printable ASCII characters");
        }
        return value;
    }

    static String requireText(String value, String name) {
        if (value == null || !isWellFormed(value) || hasControl(value)) {
            throw new IllegalArgumentException(name
                    + " must be well-formed text without control characters");
        }
        int codePoints = value.codePointCount(0, value.length());
        if (codePoints < 1 || codePoints > MAXIMUM_TEXT_CODE_POINTS) {
            throw new IllegalArgumentException(name + " must be 1 to "
                    + MAXIMUM_TEXT_CODE_POINTS + " characters");
        }
        return value;
    }

    static long requirePositive(long value, String name) {
        if (value < 1) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }

    static boolean isWellFormed(String value) {
        int index = 0;
        while (index < value.length()) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 == value.length()
                        || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return false;
                }
                index += 2;
            } else if (Character.isLowSurrogate(character)) {
                return false;
            } else {
                index++;
            }
        }
        return true;
    }

    // Unicode category Cc: C0 controls, DEL and C1 controls.
    static boolean hasControl(String value) {
        return value.codePoints().anyMatch(Character::isISOControl);
    }
}
