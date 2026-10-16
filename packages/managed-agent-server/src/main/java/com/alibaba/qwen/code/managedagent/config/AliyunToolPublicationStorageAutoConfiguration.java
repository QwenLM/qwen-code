package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.store.AliyunToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.aliyun.oss.ClientBuilderConfiguration;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.common.auth.CredentialsProvider;
import com.aliyun.oss.common.auth.CredentialsProviderFactory;
import com.aliyun.oss.common.comm.SignVersion;
import org.apache.commons.lang3.StringUtils;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

import java.net.URI;

@AutoConfiguration
@ConditionalOnProperty(prefix = "qwen.managed-agent.tool-publication",
        name = "enabled", havingValue = "true")
@ConditionalOnBean(ToolPublicationConfiguration.class)
@ConditionalOnMissingBean(ToolPublicationObjectStore.class)
public class AliyunToolPublicationStorageAutoConfiguration {
    @Bean(destroyMethod = "shutdown")
    public OSS toolPublicationOss(ManagedAgentProperties properties) throws Exception {
        return buildOss(properties, CredentialsProviderFactory.newEnvironmentVariableCredentialsProvider());
    }

    public static OSS buildOss(ManagedAgentProperties properties, CredentialsProvider credentials) {
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

    @Bean
    public ToolPublicationObjectStore toolPublicationObjects(OSS toolPublicationOss,
            ManagedAgentProperties properties) {
        return new AliyunToolPublicationObjectStore(toolPublicationOss,
                properties.getToolPublication().getOssBucket());
    }

    private static String required(String value, String label) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Tool publication " + label + " is required");
        }
        return value;
    }
}
