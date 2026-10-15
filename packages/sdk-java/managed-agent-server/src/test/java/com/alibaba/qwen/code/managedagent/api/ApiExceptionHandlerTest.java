package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.aliyun.oss.OSSException;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ApiExceptionHandlerTest {
    @Test
    void preservesBrokerRefusalStatusCodeAndRetryabilityThroughAdvice() throws Exception {
        for (int statusCode : List.of(409, 499, 503)) {
            boolean retryable = statusCode == 503;
            var mvc = MockMvcBuilders.standaloneSetup(new RefusalController(
                    new RuntimeBrokerException(statusCode, "csi_original_activation_unavailable", "unavailable", retryable)))
                    .setControllerAdvice(new ApiExceptionHandler()).addFilters(new RequestIdFilter()).build();
            mvc.perform(get("/broker-refusal").accept(MediaType.TEXT_EVENT_STREAM)
                    .header(RequestIdFilter.HEADER, "csi-proof-test"))
                    .andExpect(status().is(statusCode))
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.error.code").value("csi_original_activation_unavailable"))
                    .andExpect(jsonPath("$.error.message").value("unavailable"))
                    .andExpect(jsonPath("$.error.retryable").value(retryable))
                    .andExpect(jsonPath("$.error.request_id").value("csi-proof-test"));
        }
    }

    @Test
    void unrelatedExceptionsRetainTheirGenericInternalEnvelope() throws Exception {
        var mvc = MockMvcBuilders.standaloneSetup(new RefusalController(new IllegalStateException("private diagnosis")))
                .setControllerAdvice(new ApiExceptionHandler()).addFilters(new RequestIdFilter()).build();
        mvc.perform(get("/broker-refusal"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("internal_error"))
                .andExpect(jsonPath("$.error.message").value("The Managed Agent request failed."))
                .andExpect(jsonPath("$.error.retryable").doesNotExist());
    }

    @Test
    void leavesAStartedBrokerStreamAlone() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        response.setCommitted(true);
        assertThat(new ApiExceptionHandler().broker(new RuntimeBrokerException(
                409, "csi_original_activation_unavailable", "unavailable", false),
                new MockHttpServletRequest(), response)).isNull();
        assertThat(response.getContentAsByteArray()).isEmpty();
    }

    @Test
    void reportsOssAccessDeniedAsDefiniteRejection() {
        OSSException denied = mock(OSSException.class);
        when(denied.getErrorCode()).thenReturn("AccessDenied");
        var response = new ApiExceptionHandler().objectStore(denied,
                new MockHttpServletRequest(), new MockHttpServletResponse());
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(response.getBody()).containsKey("error");
    }

    @Test
    void leavesAStartedStreamAlone() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        response.setCommitted(true);

        assertThat(new ApiExceptionHandler().api(new ApiException(
                HttpStatus.NOT_FOUND, "session_not_found", "gone"),
                new MockHttpServletRequest(), response)).isNull();
        assertThat(new ApiExceptionHandler().broker(new RuntimeBrokerException(
                409, "workspace_unavailable", "Maintenance", false),
                new MockHttpServletRequest(), response)).isNull();
        assertThat(response.getContentAsByteArray()).isEmpty();
    }

    @RestController
    static final class RefusalController {
        private final RuntimeException refusal;

        RefusalController(RuntimeException refusal) {
            this.refusal = refusal;
        }

        @GetMapping("/broker-refusal")
        public Object refusal() {
            throw refusal;
        }
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
