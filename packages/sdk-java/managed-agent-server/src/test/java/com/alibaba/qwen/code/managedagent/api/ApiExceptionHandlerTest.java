package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.aliyun.oss.OSSException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class ApiExceptionHandlerTest {
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
        assertThat(response.getContentAsByteArray()).isEmpty();
    }
}
