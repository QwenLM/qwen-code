package com.alibaba.qwen.code.managedagent.api;

import com.aliyun.oss.OSSException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger LOG = LoggerFactory.getLogger(
            ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> api(ApiException error,
            HttpServletRequest request, HttpServletResponse response) {
        return response(request, response, error.getStatus(), error.getCode(),
                error.getMessage(), error.getDetails());
    }

    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public void disconnectedClient() {
    }

    @ExceptionHandler(OSSException.class)
    public ResponseEntity<Map<String, Object>> objectStore(OSSException error,
            HttpServletRequest request, HttpServletResponse response) {
        LOG.warn("Tool publication object store rejected request", error);
        if ("AccessDenied".equals(error.getErrorCode())) {
            return response(request, response, HttpStatus.FORBIDDEN,
                    "managed_tool_publication_storage_denied", "Tool publication storage rejected the request.");
        }
        return response(request, response, HttpStatus.INTERNAL_SERVER_ERROR,
                "internal_error", "The Managed Agent request failed.");
    }

    // The client accepts no representation of the envelope.
    @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
    public ResponseEntity<Void> notAcceptable() {
        return ResponseEntity.status(HttpStatus.NOT_ACCEPTABLE).build();
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Map<String, Object>> missingResource(
            NoResourceFoundException error, HttpServletRequest request,
            HttpServletResponse response) {
        return response(request, response, HttpStatus.NOT_FOUND, "not_found",
                "The requested endpoint does not exist.");
    }

    @ExceptionHandler({MethodArgumentNotValidException.class,
            HttpMessageNotReadableException.class,
            ServletRequestBindingException.class,
            MethodArgumentTypeMismatchException.class,
            IllegalArgumentException.class})
    public ResponseEntity<Map<String, Object>> invalid(Exception error,
            HttpServletRequest request, HttpServletResponse response) {
        return response(request, response, HttpStatus.BAD_REQUEST,
                "invalid_request", "The request body is invalid.");
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> unexpected(Exception error,
            HttpServletRequest request, HttpServletResponse response) {
        LOG.error("Managed Agent request failed", error);
        return response(request, response, HttpStatus.INTERNAL_SERVER_ERROR,
                "internal_error",
                "The Managed Agent request failed.");
    }

    public static Map<String, Object> envelope(HttpServletRequest request,
            String code, String message) {
        return envelope(request, code, message, Map.of());
    }

    private static Map<String, Object> envelope(HttpServletRequest request,
            String code, String message, Map<String, Object> details) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        error.put("request_id", RequestIdFilter.current(request));
        error.putAll(details);
        return Map.of("error", error);
    }

    private static ResponseEntity<Map<String, Object>> response(
            HttpServletRequest request, HttpServletResponse response,
            HttpStatus status, String code, String message) {
        return response(request, response, status, code, message, Map.of());
    }

    private static ResponseEntity<Map<String, Object>> response(
            HttpServletRequest request, HttpServletResponse response,
            HttpStatus status, String code, String message,
            Map<String, Object> details) {
        // An SSE stream that already started cannot switch to an envelope.
        if (response.isCommitted()) {
            return null;
        }
        // Preset so that an SSE-only Accept header still gets the envelope.
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(envelope(request, code, message, details));
    }
}
