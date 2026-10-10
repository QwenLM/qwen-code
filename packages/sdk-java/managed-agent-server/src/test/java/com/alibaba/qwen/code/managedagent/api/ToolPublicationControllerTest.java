package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.web.MockHttpServletRequest;

class ToolPublicationControllerTest {
    @ParameterizedTest
    @CsvSource({"false,1,false", "true,1,true", "true,0,false", "true,,false"})
    void asyncAdmissionRequiresBothTheFlagAndCapability(boolean enabled, String header, boolean asynchronous)
            throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getToolPublication().setEntryConcurrency(1);
        properties.getToolPublication().setAsyncVerificationEnabled(enabled);
        ToolPublicationDataStore data = mock(ToolPublicationDataStore.class);
        ToolPublicationController controller = new ToolPublicationController(
                mock(ToolPublicationStore.class), data, mock(ToolPublicationAdmissionStore.class), properties);
        var result = new ObjectMapper().createObjectNode();
        if (asynchronous) result.put("state", "PENDING");
        else result.put("digest", "legacy-receipt");
        when(data.publishSegment(any(), eq("publication"), eq("token"), eq("operation"),
                eq("stdout"), eq(0), any(), eq(null), eq(asynchronous))).thenReturn(result);
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setContent(new byte[] {1});
        if (header != null) request.addHeader(ToolPublicationController.ASYNC_HEADER, header);
        var response = controller.segment(new TenantContext("tenant", null), "session", "publication",
                "stdout", 0, "workspace", "token", "operation", null, request);
        assertThat(response.getStatusCode().value()).isEqualTo(asynchronous ? 202 : 200);
        assertThat(response.getBody()).isEqualTo(result);
        assertThat(response.getHeaders().getCacheControl()).isEqualTo("no-store");
        if (asynchronous) {
            result.put("state", "SUCCEEDED");
            assertThat(controller.segment(new TenantContext("tenant", null), "session", "publication",
                    "stdout", 0, "workspace", "token", "operation", null, request)
                    .getStatusCode().value()).isEqualTo(200);
        }
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"resource", "seal", "prefix", "finish"})
    void allProducerRoutesForwardAsyncCapabilityAndCompletedReplays(String route) throws Exception {
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setEntryConcurrency(1);
        properties.getToolPublication().setAsyncVerificationEnabled(true);
        var data = mock(ToolPublicationDataStore.class);
        var controller = new ToolPublicationController(mock(ToolPublicationStore.class), data,
                mock(ToolPublicationAdmissionStore.class), properties);
        var result = new ObjectMapper().createObjectNode().put("state", "PENDING");
        when(data.publishResource(any(), eq("publication"), eq("token"), eq("operation"),
                eq("content:test"), eq("managed-tool-result-content"), any(), eq(true))).thenReturn(result);
        when(data.seal(any(), eq("publication"), eq("token"), eq("operation"), eq("stdout"),
                eq(1), eq(1L), eq("digest"), eq(true))).thenReturn(result);
        when(data.prefix(any(), eq("publication"), eq("token"), eq("operation"), eq("stdout"), eq(true)))
                .thenReturn(result);
        when(data.finish(any(), eq("publication"), eq("token"), eq("operation"), any(), eq(true)))
                .thenReturn(result);
        for (String state : new String[] {"PENDING", "SUCCEEDED"}) {
            result.put("state", state);
            var request = new MockHttpServletRequest();
            request.addHeader(ToolPublicationController.ASYNC_HEADER, "1");
            request.setContent("{\"segmentCount\":1,\"byteLength\":1,\"digest\":\"digest\"}"
                    .getBytes(StandardCharsets.UTF_8));
            var tenant = new TenantContext("tenant", null);
            var response = switch (route) {
                case "resource" -> controller.resource(tenant, "session", "publication", "managed-tool-result-content",
                        "content:test", "workspace", "token", "operation", request);
                case "seal" -> controller.seal(tenant, "session", "publication", "stdout", "workspace", "token", "operation", request);
                case "prefix" -> controller.prefix(tenant, "session", "publication", "stdout", "workspace", "token", "operation", "1");
                case "finish" -> controller.finish(tenant, "session", "publication", "workspace", "token", "operation", request);
                default -> throw new AssertionError(route);
            };
            assertThat(response.getStatusCode().value()).isEqualTo(state.equals("PENDING") ? 202 : 200);
            assertThat(response.getBody()).isSameAs(result);
            assertThat(response.getHeaders().getCacheControl()).isEqualTo("no-store");
        }
    }

    @Test
    void rejectsCoercedOrOverflowedRangeNumbersBeforeReading() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getToolPublication().setEntryConcurrency(1);
        ToolPublicationDataStore data = mock(ToolPublicationDataStore.class);
        ToolPublicationController controller = new ToolPublicationController(
                mock(ToolPublicationStore.class), data,
                mock(ToolPublicationAdmissionStore.class), properties);
        for (String pair : new String[] {
                "\"offset\":\"1\",\"length\":2",
                "\"offset\":1.5,\"length\":2",
                "\"offset\":0,\"length\":4294967297",
                "\"offset\":9223372036854775808,\"length\":1",
                "\"offset\":0,\"length\":\"2\""}) {
            MockHttpServletRequest request = new MockHttpServletRequest();
            request.setContent(("{\"manifestRef\":{},\"expectedIdentity\":{},\"streamId\":\"stdout\","
                    + pair + "}").getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> controller.range(new TenantContext("tenant", null),
                    "session", "publication", "workspace", "writer-token", request))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Invalid publication range");
        }
        verifyNoInteractions(data);
    }
}
