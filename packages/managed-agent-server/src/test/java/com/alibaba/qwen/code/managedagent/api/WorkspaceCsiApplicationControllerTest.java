package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

class WorkspaceCsiApplicationControllerTest {
    @Test
    void retainsOneExactNoStoreHeaderThroughTheTenantFilter() throws Exception {
        WorkspaceCsiApplicationStore store = mock(WorkspaceCsiApplicationStore.class);
        var status = new WorkspaceCsiApplicationStore.Status(
                "qwen-csi-application-retirement/1", "retirement", "SETTLING", 1,
                null, null, null);
        when(store.status(anyString(), anyString(), anyString(), anyString(), anyString())).thenReturn(status);
        when(store.command(anyString(), anyString(), anyString(), anyString(), any())).thenReturn(status);
        when(store.workerAuthority(anyString(), anyString(), anyString(), any())).thenReturn(Map.of("authorized", true));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new WorkspaceCsiApplicationController(store))
                .addFilters(new TenantContextFilter(new ObjectMapper()))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .build();
        String route = "/internal/managed-session-store/v1/sessions/session/csi-retirement";
        var read = mvc.perform(get(route).param("workspaceId", "workspace").param("retirementId", "retirement")
                .header(TenantContextFilter.HEADER, "tenant")
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, "original-token")).andReturn().getResponse();
        assertThat(read.getStatus()).isEqualTo(200);
        assertThat(read.getHeaders(HttpHeaders.CACHE_CONTROL)).containsExactly("no-store");
        for (String action : new String[] {"freeze", "cut", "finalize", "worker-authority"}) {
            var response = mvc.perform(post(route + ":" + action)
                    .header(TenantContextFilter.HEADER, "tenant")
                    .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, "original-token")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer original-token")
                    .contentType(MediaType.APPLICATION_JSON).content("{}")).andReturn().getResponse();
            assertThat(response.getStatus()).isEqualTo(200);
            assertThat(response.getHeaders(HttpHeaders.CACHE_CONTROL)).containsExactly("no-store");
        }
    }
}
