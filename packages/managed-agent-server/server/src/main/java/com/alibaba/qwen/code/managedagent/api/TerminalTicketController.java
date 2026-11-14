package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTerminalTicket;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellTerminalTicketRequest;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceTerminalRelayService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import jakarta.validation.Valid;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Mints the short-lived ticket a browser offers on the terminal WebSocket
 * upgrade. The request travels the normal authenticated WebShell surface, so
 * the full terminal admission runs here, where the deployment's authentication
 * headers are available; the upgrade itself then only consumes the ticket.
 * Mounted only with the Runtime Broker, like the terminal upgrade itself.
 */
@RestController
@RequestMapping("/api/agent/web-shell/v1")
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = "enabled", havingValue = "true")
public class TerminalTicketController {
    private final WorkspaceTerminalRelayService relay;
    private final TerminalTicketStore tickets;

    public TerminalTicketController(WorkspaceTerminalRelayService relay,
            TerminalTicketStore tickets) {
        this.relay = relay;
        this.tickets = tickets;
    }

    @PostMapping("/sessions/terminal-ticket")
    public WebShellTerminalTicket terminalTicket(TenantContext tenant,
            @Valid @RequestBody WebShellTerminalTicketRequest request) {
        RuntimeBindingRecord binding = relay.admit(tenant.tenantId(),
                tenant.actorId(), request.sessionId());
        String ticket = tickets.issue(new TerminalTicketStore.Admission(
                tenant.tenantId(), tenant.actorId(), request.sessionId(),
                request.terminalId(), binding));
        return new WebShellTerminalTicket(ticket, TerminalTicketStore.TTL.toSeconds());
    }
}
