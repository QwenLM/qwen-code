package com.alibaba.qwen.code.managedagent.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * H5b/H5c: the shapes of the trusted channel adapter surface
 * (/internal/managed-channels/v1). Internal, so outside the public
 * contract; kept beside ApiModels, never inside it.
 */
public final class ChannelAdapterModels {
    private ChannelAdapterModels() {
    }

    public record ChannelPolicy(
            @NotBlank @Pattern(regexp = "[a-z][a-z0-9-]{0,63}") String adapter,
            @NotBlank @Pattern(regexp = "allowlist|open|disabled")
                    String senderPolicy,
            @NotNull @Size(max = 1024) List<@NotBlank String> allowedSenders,
            @NotBlank @Pattern(regexp = "followup|steer") String dispatchMode) {
    }

    public record RegisterChannelRequest(
            @NotBlank @Size(max = 64) String platform,
            @NotBlank @Size(max = 512) String accountId,
            @Min(1) long accountGeneration,
            @NotBlank @Size(max = 512) String actorId,
            @NotBlank @Size(max = 128) String workspaceId,
            @Size(max = 1024) String cwdRelative,
            @NotNull @Valid ChannelPolicy policy) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ChannelInstanceView(String channelId, String platform,
            String accountId, long accountGeneration, String state,
            String workspaceId, String cwdRelative, long createdAt,
            long updatedAt) {
    }

    public record RouteScope(
            @NotBlank @Pattern(regexp = "user|chat_thread|thread|single")
                    String kind,
            @Size(max = 512) String senderId,
            @Size(max = 512) String chatId,
            @Size(max = 512) String threadId) {
    }

    public record InboundAttachment(
            @NotBlank @Size(max = 128) String fileName,
            @NotBlank @Size(max = 128) String mimeType,
            @NotNull @Size(max = 2_000_000) String bytesBase64) {
    }

    public record InboundEventRequest(
            @Min(1) long accountGeneration,
            @NotBlank @Size(max = 512) String platformEventId,
            @Min(1) long semanticRevision,
            @NotNull @Valid RouteScope scope,
            @NotBlank @Size(max = 512) String senderId,
            @Size(max = 512) String chatId,
            @Size(max = 512) String threadId,
            @Size(max = 200) String subject,
            @NotNull @Size(max = 32_000) String text,
            @Size(max = 16) List<@Valid InboundAttachment> attachments,
            JsonNode replyContext) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record InboundAdmission(String inputId, String turnId,
            String sessionId, String routeId, long routeRevision,
            boolean replayed) {
    }

    public record ClaimRequest(@Min(1) @Max(16) Integer limit) {
    }

    public record ClaimedSegment(int ordinal, String segmentId,
            String text) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ClaimedDelivery(String deliveryId, String sessionId,
            String routeId, long routeRevision, String state,
            String text, JsonNode replyContext,
            List<ClaimedSegment> segments) {
    }

    public record ClaimResponse(List<ClaimedDelivery> deliveries) {
    }

    public record ReceiptRequest(
            @NotBlank @Pattern(regexp = "accepted|unknown|rejected")
                    String outcome,
            @Min(0) Integer ordinal,
            @Size(max = 512) String providerMessageId,
            @Min(0) Long acceptedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DeliveryView(String deliveryId, String sessionId,
            String state, String providerReceipt, long createdAt,
            long updatedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ResendResponse(String deliveryId, String resentFrom,
            boolean possibleDuplicate, DeliveryView delivery) {
    }
}
