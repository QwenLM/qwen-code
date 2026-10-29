package com.alibaba.qwen.code.managedagent.persistence;

import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;

import java.nio.charset.StandardCharsets;

/** Shared identity helpers of the H5 channel persistence. */
final class ChannelStoreSupport {
    private ChannelStoreSupport() {
    }

    static String sha256(String value) {
        return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }

    static String requireId(String value, String name) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
