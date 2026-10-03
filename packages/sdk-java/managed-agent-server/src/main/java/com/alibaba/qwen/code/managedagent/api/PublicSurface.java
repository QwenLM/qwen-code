package com.alibaba.qwen.code.managedagent.api;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.server.PathContainer;
import org.springframework.web.util.ServletRequestPathUtils;

/**
 * The public-surface predicate shared by the tenant and signature filters.
 * Both decide coverage on the path Spring routes with, so a normalized
 * spelling (percent-encoding, path parameters) cannot slip between them.
 */
public final class PublicSurface {
    private PublicSurface() {
    }

    public static String pathWithinApplication(HttpServletRequest request) {
        // The router's own parsed path: segments are UTF-8-decoded and
        // matrix-stripped regardless of the request's Content-Type charset,
        // which UrlPathHelper would wrongly honor here. value() is the raw
        // segment; valueToMatch() is what the router matches on.
        StringBuilder path = new StringBuilder();
        for (PathContainer.Element element : ServletRequestPathUtils
                .parseAndCache(request).pathWithinApplication().elements()) {
            if (element instanceof PathContainer.PathSegment segment) {
                path.append('/').append(segment.valueToMatch());
            }
        }
        return path.toString();
    }

    public static boolean covers(String path) {
        // The bare collection route (POST /v1/agents) has no trailing slash,
        // so the prefix alone would let it skip the public surface.
        return path.equals("/v1/agents") || path.startsWith("/v1/agents/")
                || path.startsWith("/api/agent/web-shell/v1/");
    }
}
