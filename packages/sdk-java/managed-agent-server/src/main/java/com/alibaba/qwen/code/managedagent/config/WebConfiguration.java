package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import java.util.List;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfiguration implements WebMvcConfigurer {
    private final TenantContextArgumentResolver tenantResolver;

    public WebConfiguration(TenantContextArgumentResolver tenantResolver) {
        this.tenantResolver = tenantResolver;
    }

    @Override
    public void addArgumentResolvers(
            List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(tenantResolver);
    }
}
