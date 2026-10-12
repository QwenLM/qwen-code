package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannel;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicChannelDelivery;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.service.ManagedChannelService;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * H5c: the public channel resources, read-only over the registered
 * connections, the V47 ingress rows and the V47 delivery ledger. No
 * Runtime identity, credential, path or PID reaches these answers.
 */
@RestController
@RequestMapping("/v1/agent-channels")
public class ManagedChannelController {
    private final ManagedChannelService service;

    public ManagedChannelController(ManagedChannelService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<PublicList<PublicChannel>> list(
            TenantContext tenant,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.listChannels(tenant.tenantId(),
                        tenant.actorId(), cursor, limit));
    }

    @GetMapping("/{channelId}/deliveries")
    public ResponseEntity<PublicList<PublicChannelDelivery>> deliveries(
            TenantContext tenant, @PathVariable String channelId,
            @RequestParam(required = false) String cursor,
            @RequestParam(defaultValue = "20") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.listDeliveries(tenant.tenantId(),
                        tenant.actorId(), channelId, cursor, limit));
    }

    @GetMapping("/{channelId}/deliveries/{deliveryId}")
    public ResponseEntity<PublicChannelDelivery> delivery(
            TenantContext tenant, @PathVariable String channelId,
            @PathVariable String deliveryId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.getDelivery(tenant.tenantId(),
                        tenant.actorId(), channelId, deliveryId));
    }
}
