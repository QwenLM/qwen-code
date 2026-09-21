package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;

final class BrokerValues {
    private static final int MAXIMUM_ID_LENGTH = 512;

    private BrokerValues() {
    }

    static String requireId(String value, String name) {
        if (value == null || value.isEmpty()
                || value.length() > MAXIMUM_ID_LENGTH
                || value.indexOf('\0') >= 0) {
            throw new IllegalArgumentException(name
                    + " must be a bounded non-empty string");
        }
        return value;
    }

    static URI requireOrigin(URI value, String name) {
        if (value == null
                || (!("http".equalsIgnoreCase(value.getScheme()))
                        && !("https".equalsIgnoreCase(value.getScheme())))
                || value.getHost() == null
                || value.getUserInfo() != null
                || value.getQuery() != null
                || value.getFragment() != null
                || !(value.getPath().isEmpty()
                        || "/".equals(value.getPath()))) {
            throw new IllegalArgumentException(name
                    + " must be an HTTP(S) origin");
        }
        return value.resolve("/");
    }
}
