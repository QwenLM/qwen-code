package com.alibaba.qwen.code.managedagent.api;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.util.UrlPathHelper;

/**
 * The public-surface predicate shared by the tenant and signature filters.
 * Both decide coverage on the path Spring routes with, so a normalized
 * spelling (percent-encoding, path parameters) cannot slip between them.
 */
public final class PublicSurface {
    private PublicSurface() {
    }

    public static String pathWithinApplication(HttpServletRequest request) {
        return UrlPathHelper.defaultInstance.getPathWithinApplication(request);
    }

    public static boolean covers(String path) {
        // The bare collection route (POST /v1/agents) has no trailing slash,
        // so the prefix alone would let it skip the public surface.
        return path.equals("/v1/agents") || path.startsWith("/v1/agents/")
                || path.startsWith("/api/agent/web-shell/v1/");
    }
}
