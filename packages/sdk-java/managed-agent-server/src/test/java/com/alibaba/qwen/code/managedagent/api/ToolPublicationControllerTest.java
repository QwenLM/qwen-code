package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class ToolPublicationControllerTest {
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
