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
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
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

    // Client-side dispatch mistakes are not server faults: a 405 carries the
    // Allow header and a 415 names the real problem, instead of the
    // catch-all turning them into 500 internal_error.
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> methodNotSupported(
            HttpRequestMethodNotSupportedException error,
            HttpServletRequest request, HttpServletResponse response) {
        if (response.isCommitted()) {
            return null;
        }
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .headers(error.getHeaders())
                .contentType(MediaType.APPLICATION_JSON)
                .body(envelope(request, "method_not_allowed",
                        "The request method is not supported for this"
                                + " endpoint."));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> mediaTypeNotSupported(
            HttpMediaTypeNotSupportedException error,
            HttpServletRequest request, HttpServletResponse response) {
        return response(request, response, HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "The request content type is not supported.");
    }

    @ExceptionHandler({MethodArgumentNotValidException.class,
            HttpMessageNotReadableException.class})
    public ResponseEntity<Map<String, Object>> invalid(Exception error,
            HttpServletRequest request, HttpServletResponse response) {
        return response(request, response, HttpStatus.BAD_REQUEST,
                "invalid_request", "The request body is invalid.");
    }

    // Parameter-binding failures are not body failures; name the parameter
    // so the client fixes the right thing.
    @ExceptionHandler({ServletRequestBindingException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, Object>> invalidParameter(
            Exception error, HttpServletRequest request,
            HttpServletResponse response) {
        String message;
        if (error instanceof MethodArgumentTypeMismatchException mismatch) {
            message = "Request parameter '" + mismatch.getName()
                    + "' has an invalid value.";
        } else if (error instanceof MissingServletRequestParameterException missing) {
            message = "Request parameter '" + missing.getParameterName()
                    + "' is required.";
        } else {
            message = "A request parameter is missing or invalid.";
        }
        return response(request, response, HttpStatus.BAD_REQUEST,
                "invalid_request", message);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> invalidArgument(
            IllegalArgumentException error, HttpServletRequest request,
            HttpServletResponse response) {
        return response(request, response, HttpStatus.BAD_REQUEST,
                "invalid_request", "The request is invalid.");
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
