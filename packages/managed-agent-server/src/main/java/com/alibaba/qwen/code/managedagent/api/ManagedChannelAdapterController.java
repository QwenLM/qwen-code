package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ChannelInstanceView;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ClaimResponse;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.DeliveryView;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundAdmission;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.InboundEventRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ReceiptRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.RegisterChannelRequest;
import com.alibaba.qwen.code.managedagent.api.ChannelAdapterModels.ResendResponse;
import com.alibaba.qwen.code.managedagent.service.ManagedChannelService;
import jakarta.validation.Valid;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * H5b/H5c: the trusted channel adapter surface. Internal — served on the
 * internal listener only, like the Session store — and opt-in through
 * qwen.managed-agent.channels.enabled. The tenant comes from the tenant
 * header; the adapter deployment is the trusted connection the reference
 * design names.
 */
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.channels",
        name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-channels/v1/channels/{channelId}")
public class ManagedChannelAdapterController {
    private final ManagedChannelService service;

    public ManagedChannelAdapterController(ManagedChannelService service) {
        this.service = service;
    }

    @PutMapping
    public ChannelInstanceView register(TenantContext tenant,
            @PathVariable String channelId,
            @Valid @RequestBody RegisterChannelRequest request) {
        return service.register(tenant.tenantId(), channelId, request);
    }

    @PostMapping("/disconnect")
    public ChannelInstanceView disconnect(TenantContext tenant,
            @PathVariable String channelId) {
        return service.disconnect(tenant.tenantId(), channelId);
    }

    @PostMapping("/inbound")
    public InboundAdmission inbound(TenantContext tenant,
            @PathVariable String channelId,
            @Valid @RequestBody InboundEventRequest request) {
        return service.submitInbound(tenant.tenantId(), channelId, request);
    }

    @PostMapping("/deliveries:claim")
    public ClaimResponse claim(TenantContext tenant,
            @PathVariable String channelId,
            @Valid @RequestBody(required = false) ClaimRequest request) {
        int limit = request == null || request.limit() == null ? 16
                : request.limit();
        return service.claimDeliveries(tenant.tenantId(), channelId, limit);
    }

    @PostMapping("/deliveries/{deliveryId}:receipt")
    public DeliveryView receipt(TenantContext tenant,
            @PathVariable String channelId, @PathVariable String deliveryId,
            @Valid @RequestBody ReceiptRequest request) {
        return service.receipt(tenant.tenantId(), channelId, deliveryId,
                request);
    }

    @PostMapping("/deliveries/{deliveryId}:resend")
    public ResendResponse resend(TenantContext tenant,
            @PathVariable String channelId,
            @PathVariable String deliveryId) {
        return service.resend(tenant.tenantId(), channelId, deliveryId);
    }
}
