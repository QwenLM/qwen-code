package com.alibaba.acp.sdk.protocol.agent.request;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.agent.request.AuthenticateRequest.AuthenticateRequestParams;

@JSONType(typeName = "authenticate")
public class AuthenticateRequest extends Request<AuthenticateRequestParams> {
    public AuthenticateRequest() {
        this(new AuthenticateRequestParams());
    }

    public AuthenticateRequest(AuthenticateRequestParams requestParams) {
        super("authenticate", requestParams);
    }

    public static class AuthenticateRequestParams extends Meta {
        private String methodId;

        // Getters and setters
        public String getMethodId() {
            return methodId;
        }

        public void setMethodId(String methodId) {
            this.methodId = methodId;
        }
    }
}
