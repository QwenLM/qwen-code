package com.alibaba.qwen.code.managedagent.api;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.config.InternalSurfaceConfiguration.RoutingFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStorageException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.mock.http.MockHttpInputMessage;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.validation.BeanPropertyBindingResult;
import org.springframework.validation.FieldError;
import org.springframework.validation.ObjectError;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

class ApiExceptionHandlerTest {
    private static final String SECRET = "sk_live_PRIVATE_BODY_VALUE";
    private static final String CONTRACT =
            "com.alibaba.qwen.code.managedagent.store.ToolPublicationContract";

    @Test
    void reportsStorageAccessDeniedAsDefiniteRejectionWithoutProviderDetails() {
        var denied = new ToolPublicationStorageException(ToolPublicationStorageException.Reason.ACCESS_DENIED,
                new IllegalStateException("private backend diagnostics"));
        var response = new ApiExceptionHandler().objectStore(denied,
                new MockHttpServletRequest(), new MockHttpServletResponse());
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(errorCode(response.getBody())).isEqualTo("managed_tool_publication_storage_denied");
        assertThat(response.getBody().toString()).doesNotContain("private backend diagnostics");
    }

    @Test
    void storageFailuresKeepTheGenericPublicResponse() {
        var failure = new ToolPublicationStorageException(ToolPublicationStorageException.Reason.FAILURE,
                new IllegalStateException("private backend diagnostics"));
        var response = new ApiExceptionHandler().objectStore(failure,
                new MockHttpServletRequest(), new MockHttpServletResponse());
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(errorCode(response.getBody())).isEqualTo("internal_error");
        assertThat(response.getBody().toString()).doesNotContain("private backend diagnostics");
    }

    @Test
    void leavesAStartedStreamAlone() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        response.setCommitted(true);

        assertThat(new ApiExceptionHandler().api(new ApiException(
                HttpStatus.NOT_FOUND, "session_not_found", "gone"),
                new MockHttpServletRequest(), response)).isNull();
        assertThat(new ApiExceptionHandler().runtime(new RuntimeBrokerException(
                409, "workspace_unavailable", "Maintenance", false),
                new MockHttpServletRequest(), response)).isNull();
        assertThat(response.getContentAsByteArray()).isEmpty();
    }

    @Test
    void answersMethodDispatchErrorsWith405AndTheAllowHeader() {
        var response = new ApiExceptionHandler().methodNotSupported(
                new HttpRequestMethodNotSupportedException("POST",
                        List.of("GET", "PATCH")),
                new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(response.getStatusCode())
                .isEqualTo(HttpStatus.METHOD_NOT_ALLOWED);
        assertThat(response.getHeaders().getFirst(HttpHeaders.ALLOW))
                .isEqualTo("GET, PATCH");
        assertThat(errorCode(response.getBody()))
                .isEqualTo("method_not_allowed");
    }

    @Test
    void answersContentTypeDispatchErrorsWith415() {
        var response = new ApiExceptionHandler().mediaTypeNotSupported(
                new HttpMediaTypeNotSupportedException(MediaType.TEXT_PLAIN,
                        List.of(MediaType.APPLICATION_JSON)),
                new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(response.getStatusCode())
                .isEqualTo(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
        assertThat(errorCode(response.getBody()))
                .isEqualTo("unsupported_media_type");
    }

    @Test
    void namesTheOffendingParameterOnTypeMismatch() throws Exception {
        MethodParameter parameter = new MethodParameter(
                ApiExceptionHandlerTest.class.getDeclaredMethod(
                        "sampleEndpoint", int.class), 0);
        var response = new ApiExceptionHandler().invalidParameter(
                new MethodArgumentTypeMismatchException("abc", int.class,
                        "limit", parameter, null),
                new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsKey("error");
        assertThat(errorMessage(response.getBody())).contains("'limit'");
    }

    @Test
    void namesTheMissingParameterOnBindingFailure() {
        var response = new ApiExceptionHandler().invalidParameter(
                new MissingServletRequestParameterException("workspaceId",
                        "String"),
                new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorMessage(response.getBody()))
                .contains("'workspaceId'");
    }

    @Test
    void doesNotBlameTheBodyForAnIllegalArgument() {
        var response = new ApiExceptionHandler().invalidArgument(
                new IllegalArgumentException("boom"),
                new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorMessage(response.getBody()))
                .isNotEqualTo("The request body is invalid.");
    }

    @Test
    void logsWhereAnInternalRefusalCameFromWithoutQuotingTheRequest() throws Exception {
        String grants = "/internal/managed-tool-publications/v1/sessions/s/grants";
        String acquire = "/internal/managed-session-store/v1/sessions/s/writers:acquire";
        MethodParameter parameter = sampleParameter();
        var rejected = new BeanPropertyBindingResult(new Object(), "request");
        rejected.addError(fieldError("resources[3].resourceId", "NotBlank"));
        rejected.addError(fieldError("resources[7].resourceId", "NotBlank"));
        rejected.addError(fieldError("attachments[" + SECRET + "].name", "Size"));
        rejected.addError(new ObjectError("request",
                new String[] {"ValidRange.request", "ValidRange"}, null,
                "range must be valid: " + SECRET));

        List<ILoggingEvent> events = logged(handler -> {
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST", grants),
                    new MockHttpServletResponse());
            handler.invalid(new HttpMessageNotReadableException(
                    "JSON parse error: Unrecognized token '" + SECRET + "'",
                    new MockHttpInputMessage(new byte[0])),
                    new MockHttpServletRequest("POST", acquire), new MockHttpServletResponse());
            handler.invalid(new MethodArgumentNotValidException(parameter, rejected),
                    new MockHttpServletRequest("POST", acquire), new MockHttpServletResponse());
        });

        assertThat(events).hasSize(3).allSatisfy(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getThrowableProxy()).isNull();
            assertThat(event.getFormattedMessage()).doesNotContain(SECRET);
        });
        assertThat(events.get(0).getFormattedMessage()).startsWith(
                "Managed Agent refused an internal request: POST " + grants
                        + " (IllegalArgumentException at ApiExceptionHandlerTest.refuse:");
        assertThat(events.get(1).getFormattedMessage()).isEqualTo(
                "Managed Agent refused an internal request: POST " + acquire
                        + " (HttpMessageNotReadableException)");
        // Indices and map keys are dropped, repeats collapse into one entry
        // with its count, the most frequent first and ties in name order,
        // and the total keeps what collapsed.
        assertThat(events.get(2).getFormattedMessage()).isEqualTo(
                "Managed Agent refused an internal request: POST " + acquire
                        + " (MethodArgumentNotValidException fields"
                        + " resources[].resourceId:NotBlank x2, attachments[].name:Size x1,"
                        + " request:ValidRange x1 (4 errors))");
    }

    @Test
    void boundsTheLineWhateverTheRequestHolds() throws Exception {
        MethodParameter parameter = sampleParameter();
        var rejected = new BeanPropertyBindingResult(new Object(), "request");
        for (int field = 7; field >= 1; field--) {
            rejected.addError(fieldError("f" + field, "NotNull"));
        }
        for (int item = 0; item < 1000; item++) {
            rejected.addError(fieldError("items[" + item + "].name", "NotBlank"));
        }
        String longSession = "/internal/managed-session-store/v1/sessions/" + "s".repeat(6000)
                + "/writers:acquire";

        List<ILoggingEvent> events = logged(handler -> {
            handler.invalid(new MethodArgumentNotValidException(parameter, rejected),
                    new MockHttpServletRequest("POST", "/internal/x"), new MockHttpServletResponse());
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST", longSession),
                    new MockHttpServletResponse());
        });

        // The entry behind most of the errors is kept although its name
        // sorts after the single failures.
        assertThat(events).hasSize(2);
        assertThat(events.get(0).getFormattedMessage()).endsWith(
                " (MethodArgumentNotValidException fields items[].name:NotBlank x1000,"
                        + " f1:NotNull x1, f2:NotNull x1, f3:NotNull x1, f4:NotNull x1,"
                        + " … (1007 errors))");
        assertThat(events.get(1).getFormattedMessage())
                .contains("POST " + longSession.substring(0, 256) + "… (" + longSession.length()
                        + " chars) (")
                .hasSizeLessThan(1000);
    }

    @Test
    void marksATruncationOnlyPastItsBound() throws Exception {
        MethodParameter parameter = sampleParameter();
        var five = new BeanPropertyBindingResult(new Object(), "request");
        var six = new BeanPropertyBindingResult(new Object(), "request");
        for (int field = 1; field <= 6; field++) {
            if (field <= 5) {
                five.addError(fieldError("f" + field, "NotNull"));
            }
            six.addError(fieldError("f" + field, "NotNull"));
        }
        String atBound = "/internal/" + "s".repeat(256 - "/internal/".length());

        List<ILoggingEvent> events = logged(handler -> {
            handler.invalid(new MethodArgumentNotValidException(parameter, five),
                    new MockHttpServletRequest("POST", "/internal/x"), new MockHttpServletResponse());
            handler.invalid(new MethodArgumentNotValidException(parameter, six),
                    new MockHttpServletRequest("POST", "/internal/x"), new MockHttpServletResponse());
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST", atBound),
                    new MockHttpServletResponse());
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST", atBound + "s"),
                    new MockHttpServletResponse());
        });

        assertThat(events).extracting(ILoggingEvent::getFormattedMessage).satisfiesExactly(
                first -> assertThat(first).endsWith(" f5:NotNull x1 (5 errors))"),
                second -> assertThat(second).endsWith(" f5:NotNull x1, … (6 errors))"),
                third -> assertThat(third).contains("POST " + atBound + " (")
                        .doesNotContain("…"),
                fourth -> assertThat(fourth).contains("POST " + atBound + "… (257 chars) ("));
    }

    @Test
    void logsAnInternalBindingFailureByItsParameterNotItsValue() throws Exception {
        String acquire = "/internal/managed-session-store/v1/sessions/s/writers:acquire";
        MethodParameter parameter = sampleParameter();

        List<ILoggingEvent> events = logged(handler -> {
            handler.invalidParameter(new MissingRequestHeaderException(
                    ManagedSessionStoreModels.WRITER_TOKEN_HEADER, parameter),
                    new MockHttpServletRequest("POST", acquire), new MockHttpServletResponse());
            // Declared under a name other than the Java parameter's.
            handler.invalidParameter(new MethodArgumentTypeMismatchException(SECRET, int.class,
                    "afterRevision", parameter,
                    new NumberFormatException("For input string: " + SECRET)),
                    new MockHttpServletRequest("GET", acquire), new MockHttpServletResponse());
            handler.invalidParameter(new MissingServletRequestParameterException("workspaceId",
                    "String"), new MockHttpServletRequest("GET", acquire),
                    new MockHttpServletResponse());
            handler.invalidParameter(new ServletRequestBindingException(
                    "Unsatisfied parameter conditions: " + SECRET),
                    new MockHttpServletRequest("GET", acquire), new MockHttpServletResponse());
            handler.invalidParameter(new MissingRequestHeaderException(
                    ManagedSessionStoreModels.WRITER_TOKEN_HEADER, parameter),
                    new MockHttpServletRequest("POST", "/v1/agents/sessions"),
                    new MockHttpServletResponse());
        });

        // The controller declares the parameter's name; the value, and the
        // message that would quote it, stay out.
        assertThat(events).allSatisfy(event ->
                assertThat(event.getThrowableProxy()).isNull());
        assertThat(events).extracting(ILoggingEvent::getFormattedMessage).containsExactly(
                "Managed Agent refused an internal request: POST " + acquire
                        + " (MissingRequestHeaderException for "
                        + ManagedSessionStoreModels.WRITER_TOKEN_HEADER + ")",
                "Managed Agent refused an internal request: GET " + acquire
                        + " (MethodArgumentTypeMismatchException for afterRevision)",
                "Managed Agent refused an internal request: GET " + acquire
                        + " (MissingServletRequestParameterException for workspaceId)",
                "Managed Agent refused an internal request: GET " + acquire
                        + " (ServletRequestBindingException)");
    }

    @Test
    void logsExactlyTheRoutesTheRouterKeepsInternal() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getInternalServer().setPort(4183);
        RoutingFilter router = new RoutingFilter(properties, new ObjectMapper());
        List<String> spellings = List.of(
                "/internal/managed-session-store/v1/sessions/s/writers:acquire",
                "/%69nternal/managed-session-store/v1/sessions/s/writers:acquire",
                "/internal;x=1/managed-tool-publications/v1/sessions/s/grants",
                "/internal", "/internals/x", "/api/internal/x", "/v1/agents/sessions/internal/x");

        List<String> served = new ArrayList<>();
        List<String> logged = new ArrayList<>();
        for (String spelling : spellings) {
            MockHttpServletRequest onInternalListener = new MockHttpServletRequest("POST", spelling);
            onInternalListener.setLocalPort(4183);
            MockFilterChain chain = new MockFilterChain();
            router.doFilter(onInternalListener, new MockHttpServletResponse(), chain);
            if (chain.getRequest() != null) {
                served.add(spelling);
            }
            if (!logged(handler -> handler.invalidArgument(refuse(),
                    new MockHttpServletRequest("POST", spelling),
                    new MockHttpServletResponse())).isEmpty()) {
                logged.add(spelling);
            }
        }

        // What the internal listener serves and what gets a line are one set.
        assertThat(logged).isEqualTo(served).containsExactlyElementsOf(spellings.subList(0, 3));
    }

    @Test
    void namesTheFramesFromTheThrowingHelperUpToItsCaller() {
        var nested = new IllegalArgumentException("Invalid identifier: " + SECRET);
        nested.setStackTrace(new StackTraceElement[] {
                frame("java.util.Objects", "requireNonNull", 233),
                frame(CONTRACT, "require", 441),
                frame("org.springframework.web.method.Handler", "invoke", 9),
                frame(CONTRACT, "id", 383),
                frame(CONTRACT, "token", 402),
                frame(CONTRACT, "request", 112),
                frame("com.alibaba.qwen.code.managedagent.store.ToolPublicationStore", "reserve", 50),
                frame("com.alibaba.qwen.code.managedagent.api.ToolPublicationController", "grant", 73),
                frame("com.alibaba.qwen.code.managedagent.api.TenantContextFilter", "doFilterInternal", 60),
        });
        var library = new IllegalArgumentException("Invalid UUID string: " + SECRET);
        library.setStackTrace(new StackTraceElement[] {
                frame("java.util.UUID", "fromString", 194),
                frame("org.springframework.web.method.Handler", "invoke", 9),
        });
        String grants = "/internal/managed-tool-publications/v1/sessions/s/grants";

        List<ILoggingEvent> events = logged(handler -> {
            handler.invalidArgument(nested, new MockHttpServletRequest("POST", grants),
                    new MockHttpServletResponse());
            handler.invalidArgument(library, new MockHttpServletRequest("POST", grants),
                    new MockHttpServletResponse());
        });

        // Only application frames count, the first six of them, so the
        // check that called the shared helpers is still on the line.
        assertThat(events).extracting(ILoggingEvent::getFormattedMessage).containsExactly(
                "Managed Agent refused an internal request: POST " + grants
                        + " (IllegalArgumentException at ToolPublicationContract.require:441"
                        + " < ToolPublicationContract.id:383 < ToolPublicationContract.token:402"
                        + " < ToolPublicationContract.request:112 < ToolPublicationStore.reserve:50"
                        + " < ToolPublicationController.grant:73)",
                "Managed Agent refused an internal request: POST " + grants
                        + " (IllegalArgumentException at no application frame)");
    }

    @Test
    void classifiesTheRoutedPathButLogsTheRawOne() {
        List<ILoggingEvent> events = logged(handler -> {
            for (String publicPath : List.of("/v1/agents/sessions",
                    "/v1/agents/sessions/internal/x", "/internals/x")) {
                handler.invalidArgument(refuse(), new MockHttpServletRequest("POST", publicPath),
                        new MockHttpServletResponse());
            }
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST",
                    "/%69nternal/managed-session-store/v1/sessions/a%0Ab/writers:acquire"),
                    new MockHttpServletResponse());
            handler.invalidArgument(refuse(), new MockHttpServletRequest("POST",
                    "/internal;x=1/managed-session-store/v1/sessions/s/writers:acquire"),
                    new MockHttpServletResponse());
        });

        // Public routes stay silent. Spellings that route to an internal
        // handler are logged raw, so a %0A stays encoded in the line.
        assertThat(events).extracting(ILoggingEvent::getFormattedMessage).satisfiesExactly(
                first -> assertThat(first).contains(
                        "POST /%69nternal/managed-session-store/v1/sessions/a%0Ab/writers:acquire (")
                        .doesNotContain("\n"),
                second -> assertThat(second).contains(
                        "POST /internal;x=1/managed-session-store/v1/sessions/s/writers:acquire ("));
    }

    private static IllegalArgumentException refuse() {
        return new IllegalArgumentException("Committed publication evidence is missing: " + SECRET);
    }

    // The codes a real validation run resolves, most specific first: the
    // first carries the field path with its client-chosen keys, and only the
    // last is the bare constraint.
    private static FieldError fieldError(String field, String code) {
        return new FieldError("request", field, SECRET, false,
                new String[] {code + ".request." + field, code + "." + field,
                        code + ".java.lang.String", code},
                null, "rejected: " + SECRET);
    }

    private static StackTraceElement frame(String type, String method, int line) {
        return new StackTraceElement(type, method, type.substring(type.lastIndexOf('.') + 1)
                + ".java", line);
    }

    private static MethodParameter sampleParameter() throws NoSuchMethodException {
        return new MethodParameter(ApiExceptionHandlerTest.class.getDeclaredMethod(
                "sampleEndpoint", int.class), 0);
    }

    // Only this thread's events: a background thread logging through the
    // same logger cannot change what a case sees.
    private static List<ILoggingEvent> logged(Consumer<ApiExceptionHandler> requests) {
        Logger log = (Logger) LoggerFactory.getLogger(ApiExceptionHandler.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        log.addAppender(logged);
        try {
            requests.accept(new ApiExceptionHandler());
        } finally {
            log.detachAppender(logged);
        }
        String thread = Thread.currentThread().getName();
        return logged.list.stream().filter(event -> thread.equals(event.getThreadName())).toList();
    }

    @SuppressWarnings("unused")
    private static void sampleEndpoint(int limit) {
    }

    private static Object errorCode(Map<String, Object> body) {
        return errorField(body, "code");
    }

    private static String errorMessage(Map<String, Object> body) {
        return (String) errorField(body, "message");
    }

    @SuppressWarnings("unchecked")
    private static Object errorField(Map<String, Object> body, String key) {
        return ((Map<String, Object>) body.get("error")).get(key);
    }
}
