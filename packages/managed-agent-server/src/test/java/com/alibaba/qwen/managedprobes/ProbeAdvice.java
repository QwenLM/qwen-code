package com.alibaba.qwen.managedprobes;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * Probe-lane diagnosis: the production 400 handler answers with a
 * deliberately generic envelope and no log, so contract refusals are
 * unreadable on the wire. This advice logs the full cause and embeds it in
 * the envelope. It lives outside the scanned {@code com.alibaba.qwen.code}
 * package, so only a probe witness that lists it as an explicit application
 * source registers it; {@code HostedRecoveryWedgeGate} deliberately omits it
 * and observes the production envelope as it is.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public final class ProbeAdvice {
    @ExceptionHandler(IllegalArgumentException.class)
    ResponseEntity<Map<String, Object>> probeInvalid(IllegalArgumentException error,
            HttpServletRequest request) {
        System.out.println("PROBE_CONTRACT_REFUSAL " + request.getMethod() + " "
                + request.getRequestURI() + " query=" + request.getQueryString());
        error.printStackTrace(System.out);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                "error", Map.of(
                        "code", "invalid_request",
                        "message", "The request body is invalid.",
                        "diagnostic", String.valueOf(error.getMessage()))));
    }
}
