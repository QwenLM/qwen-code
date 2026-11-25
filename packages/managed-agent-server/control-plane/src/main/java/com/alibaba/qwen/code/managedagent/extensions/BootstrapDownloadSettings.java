package com.alibaba.qwen.code.managedagent.extensions;

import java.time.Duration;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

public record BootstrapDownloadSettings(Set<String> allowedHosts, long maxBytes, int maxConcurrency,
        Duration connectTimeout, Duration requestTimeout) {
    public BootstrapDownloadSettings {
        if (maxBytes < 1 || maxBytes > 100L * 1024 * 1024 || maxConcurrency < 1
                || maxConcurrency > 16 || connectTimeout == null || requestTimeout == null
                || connectTimeout.isZero() || connectTimeout.isNegative()
                || requestTimeout.isZero() || requestTimeout.isNegative()) {
            throw new IllegalArgumentException("Invalid bootstrap download limits");
        }
        allowedHosts = allowedHosts == null ? Set.of() : allowedHosts.stream()
                .filter(host -> host != null && !host.isBlank())
                .map(host -> host.trim().toLowerCase(Locale.ROOT)).collect(Collectors.toUnmodifiableSet());
    }
}
