package com.alibaba.qwen.code.managedagent.adapters.artifact;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStoreFactory;

import java.net.URI;
import java.util.Map;

public final class AliyunImmutableObjectStoreFactory implements ImmutableObjectStoreFactory {
    @Override
    public String kind() {
        return "aliyun-oss";
    }

    @Override
    public void validate(Map<String, String> options) {
        String region = required(options, "region");
        String bucket = required(options, "bucket");
        URI endpoint = URI.create(required(options, "endpoint"));
        if (!region.matches("[a-z0-9-]+") || !bucket.matches("[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")
                || !"https".equals(endpoint.getScheme())
                || !("oss-" + region + ".aliyuncs.com").equals(endpoint.getHost())
                || endpoint.getPort() != -1 || endpoint.getRawUserInfo() != null
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || endpoint.getRawPath() != null && !endpoint.getRawPath().isEmpty()) {
            throw new IllegalArgumentException("OSS requires a bucket and a fixed regional HTTPS endpoint");
        }
    }

    @Override
    public ImmutableObjectStore create(Map<String, String> options) {
        validate(options);
        AliyunObjectStoreClient client;
        try {
            client = AliyunObjectStoreClient.regional(URI.create(options.get("endpoint")), options.get("region"));
        } catch (Exception error) {
            throw new IllegalStateException("Cannot create the OSS object storage client", error);
        }
        try {
            return new AliyunImmutableObjectStore(client, options.get("region"), options.get("bucket"));
        } catch (RuntimeException | Error failure) {
            client.close();
            throw failure;
        }
    }

    private static String required(Map<String, String> options, String key) {
        String value = options.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("OSS object storage requires " + key);
        }
        return value;
    }
}
