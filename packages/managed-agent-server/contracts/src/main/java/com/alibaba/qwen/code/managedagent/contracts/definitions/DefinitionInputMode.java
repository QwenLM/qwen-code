package com.alibaba.qwen.code.managedagent.contracts.definitions;

import org.apache.commons.lang3.StringUtils;

public enum DefinitionInputMode {
    PRE_REGISTERED,
    SPI;

    public static DefinitionInputMode parse(String value) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalArgumentException("Definition input mode is required");
        }
        return valueOf(value.trim().replace('-', '_').toUpperCase(java.util.Locale.ROOT));
    }
}
