package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.session.HarnessWorkPoll;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.List;

/**
 * The Hosted Harness work poll. Internal surface only: the routing filter keeps
 * it on the internal listener, and the Harness bearer token is its admission.
 */
@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.harness-pull", name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-harness-work/v1")
public class HarnessWorkController {
    private static final String BEARER = "Bearer ";
    private final HarnessWorkPoll work;

    public HarnessWorkController(HarnessWorkPoll work) {
        this.work = work;
    }

    @PostMapping(value = "/poll", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public DeferredResult<HarnessWorkPoll.Reply> poll(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody HarnessWorkPoll.Poll request) {
        String token = authorization != null && authorization.startsWith(BEARER)
                ? authorization.substring(BEARER.length()).trim() : null;
        var pending = work.poll(token, request);
        var result = new DeferredResult<HarnessWorkPoll.Reply>(HarnessWorkPoll.MAX_WAIT_MILLIS + 5_000);
        pending.whenComplete((reply, failure) -> {
            if (failure != null) {
                result.setErrorResult(failure);
            } else {
                result.setResult(reply);
            }
        });
        result.onTimeout(() -> result.setResult(new HarnessWorkPoll.Reply(List.of())));
        return result;
    }
}
