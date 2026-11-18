package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcJournalPacks;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;

/**
 * Object-store construction for the hand-constructed maintenance entry points, which are not
 * Spring-managed and therefore cannot inject the {@code ToolPublicationObjectStore} bean. Each
 * factory mirrors {@code AliyunToolPublicationStorageAutoConfiguration}: when the tool-publication
 * OSS settings are present a real store is built so evicted journal bytes resolve from the published
 * pack; when they are absent the factory returns null and the caller keeps a null bundle, so every
 * evicted read stays fail-closed. The returned client is {@link AutoCloseable}; the entry point must
 * shut it down.
 */
final class MaintenanceObjectStores {
    private MaintenanceObjectStores() {
    }

    /** K2 CSI operators read the same tool-publication OSS environment as the worker ACK command. */
    static com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient k2Oss() throws Exception {
        return regional("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_ENDPOINT",
                "QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_REGION",
                "QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_BUCKET");
    }

    /** W1 offline operators read the recovery OSS environment. */
    static com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient w1Oss() throws Exception {
        return regional("W1_OSS_ENDPOINT", "W1_OSS_REGION", "W1_OSS_BUCKET");
    }

    /**
     * Spring-context maintenance commands already bind {@link ManagedAgentSettings}; build the store
     * exactly as the auto-configuration does, gated on tool-publication being enabled and configured.
     */
    static com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient settingsOss(
            ManagedAgentSettings settings) throws Exception {
        ManagedAgentSettings.ToolPublication publication = settings.getToolPublication();
        if (publication == null || !publication.isEnabled()
                || StringUtils.isBlank(publication.getOssEndpoint())
                || StringUtils.isBlank(publication.getOssRegion())
                || StringUtils.isBlank(publication.getOssBucket())) {
            return null;
        }
        return com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient.environment(settings);
    }

    /**
     * Read-only journal-pack bundle for a binding repository: null when no store is configured, so
     * admission stays fail-closed. Settings are null because these entry points only resolve reads;
     * {@code resolveBytes} never consults the compaction settings.
     */
    static JdbcJournalPacks readPacks(JdbcTemplate jdbc, ToolPublicationObjectStore objects) {
        return objects == null ? null : new JdbcJournalPacks(jdbc, objects, null);
    }

    private static com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient regional(
            String endpointKey, String regionKey, String bucketKey) throws Exception {
        if (System.getenv(endpointKey) == null && System.getenv(regionKey) == null
                && System.getenv(bucketKey) == null) {
            return null;
        }
        URI endpoint = URI.create(required(endpointKey));
        String region = required(regionKey);
        required(bucketKey);
        if (!"https".equals(endpoint.getScheme()) || endpoint.getRawUserInfo() != null
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || endpoint.getPort() != -1 || endpoint.getRawPath() != null && !endpoint.getRawPath().isEmpty()
                || !endpoint.getHost().equals("oss-" + region + ".aliyuncs.com")) {
            throw new IllegalArgumentException("Private regional OSS endpoint is required");
        }
        return com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient.regional(endpoint, region);
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Required maintenance OSS setting is unavailable: " + name);
        }
        return value;
    }
}
