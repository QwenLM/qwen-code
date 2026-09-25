package com.alibaba.qwen.code.managedworkspace;

/**
 * Lexical rule and normal form for a Session's working directory relative to
 * its Workspace root. The rule never touches the filesystem: the Runtime still
 * verifies existence, realpath containment and symlinks before tools run.
 */
public final class WorkspaceRelativePath {
    public static final String ROOT = ".";

    private static final int MAXIMUM_CODE_POINTS = 1024;

    private WorkspaceRelativePath() {
    }

    /**
     * Returns the normal form of {@code value}. Empty and {@code .} segments
     * are dropped and nothing else changes: spaces, case and non-ASCII
     * characters are kept, with no Unicode normalization or percent-decoding.
     *
     * @throws WorkspaceException {@code invalid_cwd} when the value is not a
     *     well-formed relative path of 1 to 1024 code points, contains a
     *     control character, a backslash, a leading {@code /} or a {@code ..}
     *     segment, or when its normal form starts with a drive prefix
     */
    public static String normalize(String value) {
        if (value == null) {
            throw new IllegalArgumentException("cwdRelative is required");
        }
        if (!WorkspaceValues.isWellFormed(value)) {
            throw WorkspaceException.invalidCwd();
        }
        int codePoints = value.codePointCount(0, value.length());
        if (codePoints < 1 || codePoints > MAXIMUM_CODE_POINTS
                || WorkspaceValues.hasControl(value)
                || value.indexOf('\\') >= 0
                || value.startsWith("/")) {
            throw WorkspaceException.invalidCwd();
        }
        StringBuilder normalized = new StringBuilder(value.length());
        for (String segment : value.split("/", -1)) {
            if (segment.equals("..")) {
                throw WorkspaceException.invalidCwd();
            }
            if (segment.isEmpty() || segment.equals(ROOT)) {
                continue;
            }
            if (normalized.length() > 0) {
                normalized.append('/');
            }
            normalized.append(segment);
        }
        // Checked on the normal form: dropping a leading "." segment would
        // otherwise turn ./C:x into the drive path C:x.
        if (hasDrivePrefix(normalized)) {
            throw WorkspaceException.invalidCwd();
        }
        return normalized.length() == 0 ? ROOT : normalized.toString();
    }

    private static boolean hasDrivePrefix(CharSequence value) {
        if (value.length() < 2 || value.charAt(1) != ':') {
            return false;
        }
        char first = value.charAt(0);
        return (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z');
    }
}
