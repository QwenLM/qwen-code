package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.artifact.ManagedToolDetailsService;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellShellResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolDetails;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolResultRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class ManagedToolDetailsController {
    private final ManagedToolDetailsService service;

    public ManagedToolDetailsController(ManagedToolDetailsService service) {
        this.service = service;
    }

    @PostMapping("/api/agent/web-shell/v1/tool-details/get")
    public ResponseEntity<WebShellToolDetails> get(TenantContext tenant,
            @Valid @RequestBody WebShellToolResultRequest request) {
        return ResponseEntity.ok().header("Cache-Control", "private, no-store")
                .body(service.get(tenant, request.sessionId(), request.itemId()));
    }

    @GetMapping("/v1/agents/sessions/{sessionId}/items/{itemId}/tool-details")
    public ResponseEntity<PublicToolDetails> publicGet(TenantContext tenant,
            @PathVariable String sessionId, @PathVariable String itemId) {
        return ResponseEntity.ok().header("Cache-Control", "private, no-store")
                .body(PublicToolDetails.from(service.get(tenant, sessionId, itemId)));
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicToolDetails(JsonNode input, String output, boolean truncated,
            @JsonProperty("shell_result") PublicShellResult shellResult) {
        static PublicToolDetails from(WebShellToolDetails details) {
            return new PublicToolDetails(details.input(), details.output(), details.truncated(),
                    details.shellResult() == null ? null : PublicShellResult.from(details.shellResult()));
        }
    }

    public record PublicShellResult(String type, int version, String text, String output,
            String directory, @JsonProperty("exit_code") Long exitCode, Long signal, Long pid,
            String error, String outcome, List<String> notices, boolean truncated,
            @JsonProperty("output_files") List<String> outputFiles) {
        static PublicShellResult from(WebShellShellResult result) {
            return new PublicShellResult(result.type(), result.version(), result.text(),
                    result.output(), result.directory(), result.exitCode(), result.signal(),
                    result.pid(), result.error(), result.outcome(), result.notices(),
                    result.truncated(), result.outputFiles());
        }
    }
}
