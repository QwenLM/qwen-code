package com.alibaba.qwen.code.managedagent.adapters.artifact;

import com.aliyun.oss.ClientBuilderConfiguration;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.common.auth.CredentialsProvider;
import com.aliyun.oss.common.auth.CredentialsProviderFactory;
import com.aliyun.oss.common.comm.SignVersion;
import org.apache.commons.lang3.StringUtils;

import java.net.URI;
public final class AliyunObjectStoreClient implements AutoCloseable {
    private final OSS client;
    public AliyunObjectStoreClient(OSS client) { this.client = client; }
    public static AliyunObjectStoreClient environment(com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings settings) throws Exception {
        return new AliyunObjectStoreClient(buildOss(settings, CredentialsProviderFactory.newEnvironmentVariableCredentialsProvider()));
    }
    public static AliyunObjectStoreClient regional(URI endpoint, String region) throws Exception {
        var configuration = new ClientBuilderConfiguration();
        configuration.setSignatureVersion(SignVersion.V4);
        AliyunToolPublicationObjectStore.configureClientRetries(configuration);
        return new AliyunObjectStoreClient(OSSClientBuilder.create().endpoint(endpoint.toString()).region(region)
                .credentialsProvider(CredentialsProviderFactory.newEnvironmentVariableCredentialsProvider())
                .clientConfiguration(configuration).build());
    }
    public AliyunToolPublicationObjectStore objects(String bucket) { return new AliyunToolPublicationObjectStore(client, bucket); }
    public void shutdown() { client.shutdown(); }
    public void close() { shutdown(); }
    public static OSS buildOss(com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties, CredentialsProvider credentials) {
        var settings = properties.getToolPublication();
        URI endpoint = URI.create(required(settings.getOssEndpoint(), "OSS endpoint"));
        String region = required(settings.getOssRegion(), "OSS region");
        if (!"https".equals(endpoint.getScheme()) || endpoint.getHost() == null
                || endpoint.getRawPath() != null && !endpoint.getRawPath().isEmpty()
                || endpoint.getRawQuery() != null || endpoint.getRawUserInfo() != null
                || !endpoint.getHost().equals("oss-" + region + ".aliyuncs.com")) {
            throw new IllegalStateException("Tool publication requires a fixed regional HTTPS OSS endpoint");
        }
        required(settings.getOssBucket(), "OSS bucket");
        var client = new ClientBuilderConfiguration();
        client.setSignatureVersion(SignVersion.V4);
        AliyunToolPublicationObjectStore.configureClientRetries(client);
        return OSSClientBuilder.create().endpoint(endpoint.toString())
                .region(region)
                .credentialsProvider(credentials)
                .clientConfiguration(client).build();
    }

    private static String required(String value, String label) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Tool publication " + label + " is required");
        }
        return value;
    }
}
