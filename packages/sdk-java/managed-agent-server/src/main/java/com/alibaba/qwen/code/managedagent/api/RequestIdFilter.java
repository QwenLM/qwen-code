package com.alibaba.qwen.code.managedagent.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-Id";
    private static final String MDC_KEY = "requestId";
    private static final String ATTRIBUTE = RequestIdFilter.class.getName();
    // Header-safe and log-safe: visible ASCII only, up to the contract's 128.
    private static final Pattern SAFE = Pattern.compile("[\\x21-\\x7E]{1,128}");

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String supplied = request.getHeader(HEADER);
        use(request, response, supplied != null
                && SAFE.matcher(supplied).matches() ? supplied
                : UUID.randomUUID().toString());
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    // The contract allows any string up to 128 characters, so an id that is
    // unsafe to echo is ignored rather than rejected.
    public static void useClientId(HttpServletRequest request,
            HttpServletResponse response, String requestId) {
        if (requestId != null && SAFE.matcher(requestId).matches()) {
            use(request, response, requestId);
        }
    }

    public static String current(HttpServletRequest request) {
        return (String) request.getAttribute(ATTRIBUTE);
    }

    private static void use(HttpServletRequest request,
            HttpServletResponse response, String requestId) {
        request.setAttribute(ATTRIBUTE, requestId);
        response.setHeader(HEADER, requestId);
        MDC.put(MDC_KEY, requestId);
    }
}
