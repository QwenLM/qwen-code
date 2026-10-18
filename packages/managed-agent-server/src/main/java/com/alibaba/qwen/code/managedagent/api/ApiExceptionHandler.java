package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.store.ToolPublicationStorageException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindingResult;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger LOG = LoggerFactory.getLogger(
            ApiExceptionHandler.class);
    private static final int LOGGED_CONSTRAINTS = 5;
    private static final int LOGGED_FRAMES = 6;
    private static final int LOGGED_URI_CHARS = 256;

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> api(ApiException error,
            HttpServletRequest request, HttpServletResponse response) {
        return response(request, response, error.getStatus(), error.getCode(),
                error.getMessage(), error.getDetails());
    }

    @ExceptionHandler(RuntimeBrokerException.class)
    public ResponseEntity<Map<String, Object>> runtime(RuntimeBrokerException error,
            HttpServletRequest request, HttpServletResponse response) {
        HttpStatus status = HttpStatus.resolve(error.getStatusCode());
        Map<String, Object> details = new LinkedHashMap<>(error.getDetails());
        details.put("retryable", error.isRetryable());
        return response(request, response, status == null ? HttpStatus.CONFLICT : status,
                error.getCode(), error.getMessage(), details);
    }

    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public void disconnectedClient() {
    }

    @ExceptionHandler(ToolPublicationStorageException.class)
    public ResponseEntity<Map<String, Object>> objectStore(ToolPublicationStorageException error,
            HttpServletRequest request, HttpServletResponse response) {
        LOG.warn("Tool publication object store rejected request", error);
        if (error.getReason() == ToolPublicationStorageException.Reason.ACCESS_DENIED) {
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
    // catch-all turning them into 500 internal_error. Spring raises the 405
    // exception from handler mapping, before any handler method writes, so
    // no committed-response guard is needed here.
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> methodNotSupported(
            HttpRequestMethodNotSupportedException error,
            HttpServletRequest request, HttpServletResponse response) {
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
        logInternalRefusal(request, error);
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
        logInternalRefusal(request, error);
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
        logInternalRefusal(request, error);
        return response(request, response, HttpStatus.BAD_REQUEST,
                "invalid_request", "The request is invalid.");
    }

    // A public caller's 400 is its own input mistake and stays out of the
    // log. An internal route is called by the control plane's own
    // components (the Harness, Runtime workers, channel adapters), and the
    // generic answer hides which check refused one (#14361), so it gets one
    // line. The line names the check without quoting the request: exception
    // messages here can carry body content (Jackson's parse errors, rejected
    // values, a forwarded channel message), so only the exception type, the
    // failing fields' names, constraints and counts, the name of a parameter
    // that did not bind, and the application frames that threw are kept.
    // The route is classified by the predicate the router uses, but the path
    // is logged raw: the routed path is decoded, and a %0A in a segment
    // would start a forged log line. Body checks run before the writer
    // credential is checked, so the line's size is bounded whatever the
    // request holds.
    private static void logInternalRefusal(HttpServletRequest request,
            Exception error) {
        if (!PublicSurface.internal(request)) {
            return;
        }
        String detail;
        if (error instanceof MethodArgumentNotValidException invalid) {
            detail = " " + constraints(invalid.getBindingResult());
        } else if (error instanceof IllegalArgumentException) {
            // The frames run from the helper that threw (often a shared
            // require) up through the check that called it.
            detail = " at " + applicationFrames(error);
        } else {
            // A body that did not parse, or a header or parameter that did
            // not bind, fails inside Spring: the type says which, and any
            // application frames on its stack are filters, not a check. A
            // binding failure names the parameter the controller declares,
            // never the value the client sent.
            String parameter = boundParameter(error);
            detail = parameter == null ? "" : " for " + parameter;
        }
        LOG.warn("Managed Agent refused an internal request: {} {} ({}{})",
                request.getMethod(), bounded(request.getRequestURI()),
                error.getClass().getSimpleName(), detail);
    }

    // Field paths keep their shape but drop list indices and map keys, which
    // the client chooses. Repeats then collapse into one entry with its
    // count, the most frequent first, so a list of thousands of bad elements
    // logs as one entry that single failures elsewhere cannot crowd out.
    private static String constraints(BindingResult result) {
        Map<String, Long> counts = result.getAllErrors().stream()
                .collect(Collectors.groupingBy(error -> error instanceof FieldError field
                        ? field.getField().replaceAll("\\[[^\\]]*\\]", "[]")
                                + ":" + field.getCode()
                        : error.getObjectName() + ":" + error.getCode(),
                        Collectors.counting()));
        return counts.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed()
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(LOGGED_CONSTRAINTS)
                .map(entry -> entry.getKey() + " x" + entry.getValue())
                .collect(Collectors.joining(", ", "fields ",
                        counts.size() > LOGGED_CONSTRAINTS ? ", …" : ""))
                + " (" + result.getErrorCount() + " errors)";
    }

    private static String boundParameter(Exception error) {
        if (error instanceof MissingRequestHeaderException missing) {
            return missing.getHeaderName();
        }
        if (error instanceof MissingServletRequestParameterException missing) {
            return missing.getParameterName();
        }
        if (error instanceof MethodArgumentTypeMismatchException mismatch) {
            return mismatch.getName();
        }
        return null;
    }

    private static String applicationFrames(Throwable error) {
        return Arrays.stream(error.getStackTrace())
                .filter(frame -> frame.getClassName()
                        .startsWith("com.alibaba.qwen.code."))
                .limit(LOGGED_FRAMES)
                .map(frame -> frame.getClassName().substring(
                        frame.getClassName().lastIndexOf('.') + 1)
                        + "." + frame.getMethodName() + ":"
                        + frame.getLineNumber())
                .collect(Collectors.collectingAndThen(Collectors.joining(" < "),
                        frames -> frames.isEmpty() ? "no application frame" : frames));
    }

    private static String bounded(String uri) {
        if (uri == null || uri.length() <= LOGGED_URI_CHARS) {
            return uri;
        }
        return uri.substring(0, LOGGED_URI_CHARS) + "… (" + uri.length() + " chars)";
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
