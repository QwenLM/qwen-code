package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ManagedMemoryController;
import com.alibaba.qwen.code.managedagent.api.ManagedMemorySessionController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Store;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryRepository;
import com.alibaba.qwen.code.managedagent.memory.ManagedMemoryService;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ManagedMemoryControllerTest {
    private final MemoryRepository repository = mock(MemoryRepository.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new ManagedMemoryController(repository))
            .setCustomArgumentResolvers(new TenantContextArgumentResolver())
            .setControllerAdvice(new ApiExceptionHandler()).build();

    @Test
    void internalMemoryResponseHasExactlyOneNoStoreDirective() throws Exception {
        var service = mock(ManagedMemoryService.class);
        var request = new Query("workspace", "writer", 1, "binding", null, null, null, null, null, null);
        when(service.query("tenant", "session", "synthetic-writer", request)).thenReturn(Result.binding("memstore_owned"));
        var callbacks = MockMvcBuilders.standaloneSetup(new ManagedMemorySessionController(service))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .addFilters(new TenantContextFilter(new ObjectMapper())).build();
        var response = callbacks.perform(post("/internal/managed-session-store/v1/sessions/session/memory:query")
                        .header("X-Qwen-Tenant-Id", "tenant").header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .contentType(MediaType.APPLICATION_JSON).content(new ObjectMapper().writeValueAsBytes(request)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.memoryStoreId").value("memstore_owned"))
                .andReturn().getResponse();
        assertThat(response.getHeaders("Cache-Control")).containsExactly("no-store");
    }

    @Test
    void usesAuthenticatedOwnerAndRejectsBodyAndQuerySelectors() throws Exception {
        var owner = new TenantContext("tenant", "owner");
        mvc.perform(post("/v1/agents/memory-stores").requestAttr(TenantContextFilter.ATTRIBUTE, owner)
                .contentType(MediaType.APPLICATION_JSON).content("{\"actorId\":\"foreign\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/v1/agents/memory-stores?tenantId=foreign").requestAttr(TenantContextFilter.ATTRIBUTE, owner))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/v1/agents/memory-stores").requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", null)))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(repository);
        when(repository.create("tenant", "owner")).thenReturn(new Store("memstore_owned", 123));
        when(repository.list("tenant", "owner")).thenReturn(List.of(new Store("memstore_owned", 123)));
        mvc.perform(post("/v1/agents/memory-stores").requestAttr(TenantContextFilter.ATTRIBUTE, owner)
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.id").value("memstore_owned"));
        mvc.perform(get("/v1/agents/memory-stores").requestAttr(TenantContextFilter.ATTRIBUTE, owner))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.data[0].created_at").value(123));
        verify(repository).create("tenant", "owner");
        verify(repository).list("tenant", "owner");
    }
}
