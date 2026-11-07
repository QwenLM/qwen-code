package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceFileUploadStore;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.InputStream;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class WorkspaceFileControllerTest {
    WorkspaceFileStore files;
    WorkspaceFileUploadStore uploads;
    MockMvc mvc;

    @BeforeEach
    void setup() {
        uploads = mock(WorkspaceFileUploadStore.class);
        files = mock(WorkspaceFileStore.class);
        mvc = MockMvcBuilders.standaloneSetup(new WorkspaceFileController(files, uploads))
                .setControllerAdvice(new ApiExceptionHandler())
                .setCustomArgumentResolvers(new TenantContextArgumentResolver()).build();
    }

    @Test
    void rawUploadPreservesBinaryBytesAndReturnsTheScopedResult() throws Exception {
        byte[] bytes = new byte[] {0, (byte) 0xff, 1};
        String id = UUID.randomUUID().toString();
        when(uploads.upload(anyString(), anyString(), any(WorkspaceFileStore.Locator.class), anyString(), anyString(), anyString(), any(), anyLong()))
                .thenAnswer(call -> {
                    assertThat(call.<String>getArgument(0)).isEqualTo("tenant");
                    assertThat(call.<String>getArgument(1)).isEqualTo("actor");
                    assertThat(call.<WorkspaceFileStore.Locator>getArgument(2)).isEqualTo(new WorkspaceFileStore.Locator(null, "workspace", "."));
                    assertThat(call.<InputStream>getArgument(6).readAllBytes()).isEqualTo(bytes);
                    return new WorkspaceFileUploadStore.UploadResult("a".repeat(64), id, "binary.bin", bytes.length, DigestUtils.sha256Hex(bytes));
                });
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/upload")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .param("workspaceId", "workspace").param("cwdRelative", ".").param("path", "binary.bin")
                .param("expectedScopeRevision", "a".repeat(64)).param("uploadId", id)
                .contentType(MediaType.APPLICATION_OCTET_STREAM).content(bytes))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.uploadId").value(id)).andExpect(jsonPath("$.sizeBytes").value(3));
    }

    @Test
    void sessionLocatorDoesNotAcceptCallerWorkspaceOrDirectory() throws Exception {
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/query")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .contentType(MediaType.APPLICATION_JSON).content("{\"sessionId\":\"session\",\"directory\":\".\"}"))
                .andExpect(status().isOk());
        verify(files).query("tenant", "actor", new WorkspaceFileStore.Locator("session", null, null), ".", "", null);
        for (String locator : new String[] {"", "\"workspaceId\":\"workspace\",", "\"sessionId\":\"session\",\"cwdRelative\":\".\",",
                "\"sessionId\":\"session\",\"workspaceId\":\"workspace\",\"cwdRelative\":\".\","}) {
            mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/read")
                    .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                    .contentType(MediaType.APPLICATION_JSON).content("{" + locator + "\"path\":\"a.txt\",\"expectedScopeRevision\":\"" + "a".repeat(64) + "\"}"))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/upload")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .param("sessionId", "session").param("workspaceId", "workspace").param("cwdRelative", ".").param("path", "file.bin")
                .param("expectedScopeRevision", "a".repeat(64)).param("uploadId", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[0]))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(uploads);
    }

    @Test
    void uploadsRequireATrustedActorAndUnencodedOctetStream() throws Exception {
        for (boolean actor : new boolean[] {false, true}) {
            mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/upload")
                    .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", actor ? "actor" : null))
                    .param("workspaceId", "workspace").param("cwdRelative", ".").param("path", "binary.bin")
                    .param("expectedScopeRevision", "a".repeat(64)).param("uploadId", UUID.randomUUID().toString())
                    .header("Content-Encoding", "gzip").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {0}))
                    .andExpect(status().is(actor ? 415 : 401));
        }
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/upload")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isUnsupportedMediaType());
        verifyNoInteractions(uploads);
    }

    @Test
    void statusQueryReturnsPendingMetadataAndRejectsUnknownFields() throws Exception {
        String id = UUID.randomUUID().toString();
        when(uploads.query("tenant", "actor", id)).thenReturn(new WorkspaceFileUploadStore.UploadStatus(
                "a".repeat(64), id, "pending", "binary.bin", 0, DigestUtils.sha256Hex(new byte[0]), null));
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/uploads/query")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .contentType(MediaType.APPLICATION_JSON).content("{\"uploadId\":\"" + id + "\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.state").value("pending"))
                .andExpect(jsonPath("$.path").value("binary.bin"));
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/files/uploads/query")
                .requestAttr(TenantContextFilter.ATTRIBUTE, new TenantContext("tenant", "actor"))
                .contentType(MediaType.APPLICATION_JSON).content("{\"uploadId\":\"" + id + "\",\"root\":\"/tmp\"}"))
                .andExpect(status().isBadRequest());
    }
}
