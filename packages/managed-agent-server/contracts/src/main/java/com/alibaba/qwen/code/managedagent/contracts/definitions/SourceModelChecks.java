package com.alibaba.qwen.code.managedagent.contracts.definitions;

import org.apache.commons.lang3.StringUtils;

import java.time.Instant;
import java.util.regex.Pattern;

final class SourceModelChecks {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern PROVIDER_ID = Pattern.compile("[a-z][a-z0-9-]{0,63}");
    private static final Pattern REVISION = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");

    private SourceModelChecks() {
    }

    static String requireId(String field, String value) {
        if (value == null || !ID.matcher(value).matches()) {
            throw new IllegalArgumentException(field + " must be a bounded nonblank identifier");
        }
        return value;
    }

    static String requireProviderId(String value) {
        if (value == null || !PROVIDER_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("providerId must match [a-z][a-z0-9-]{0,63}");
        }
        return value;
    }

    static String requireRevision(String value) {
        if (value == null || !REVISION.matcher(value).matches() || "latest".equalsIgnoreCase(value)) {
            throw new IllegalArgumentException("sourceRevision must be exact and bounded");
        }
        return value;
    }

    static String requireDigest(String value) {
        if (value == null || !DIGEST.matcher(value).matches()) {
            throw new IllegalArgumentException("projectionDigest must be lowercase SHA-256 hex");
        }
        return value;
    }

    static Instant requireDeadline(Instant value) {
        if (value == null) {
            throw new IllegalArgumentException("deadline is required");
        }
        return value;
    }

    static String requireText(String field, String value) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalArgumentException(field + " is required");
        }
        return value;
    }
}
