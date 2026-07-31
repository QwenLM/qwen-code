package com.alibaba.acp.sdk.protocol.client.response;

import com.alibaba.acp.sdk.protocol.domain.permission.RequestPermissionOutcome;
import com.alibaba.acp.sdk.protocol.jsonrpc.Error;
import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.client.response.RequestPermissionResponse.RequestPermissionResponseResult;

public class RequestPermissionResponse extends Response<RequestPermissionResponseResult> {
    public RequestPermissionResponse() {
    }

    public RequestPermissionResponse(Object id, RequestPermissionResponseResult result) {
        super(id, result);
    }

    public RequestPermissionResponse(Object id, Error error) {
        super(id, error);
    }

    public static class RequestPermissionResponseResult {
        private RequestPermissionOutcome outcome;

        public RequestPermissionResponseResult() {
        }

        public RequestPermissionResponseResult(RequestPermissionOutcome outcome) {
            this.outcome = outcome;
        }

        // Getters and setters
        public RequestPermissionOutcome getOutcome() {
            return outcome;
        }

        public void setOutcome(RequestPermissionOutcome outcome) {
            this.outcome = outcome;
        }
    }
}
