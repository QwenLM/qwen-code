package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.ManagedEventEnvelopes;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class ManagedUserQuestions {
    public static final String POLICY = "hosted-user-question/1";
    public static final int MAX_INPUT_BYTES = 16 * 1024;
    public static final int MAX_ANSWERS_BYTES = 32 * 1024;
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final Pattern BLANK = Pattern.compile(
            "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*");

    private ManagedUserQuestions() { }

    public static boolean isQuestion(JsonNode options) {
        return options.path("v").isIntegralNumber() && options.path("v").asLong() == 4;
    }

    public static ArrayNode questionsFromInput(JsonNode input) {
        closed(input, Set.of("questions"), Set.of("metadata"));
        if (input.has("metadata")) {
            closed(input.get("metadata"), Set.of(), Set.of("source"));
            if (input.get("metadata").has("source")) {
                text(input.path("metadata").get("source"), Integer.MAX_VALUE, false);
            }
        }
        JsonNode source = input.get("questions");
        require(source.isArray() && source.size() >= 1 && source.size() <= 4);
        ArrayNode result = JSON.arrayNode();
        for (int index = 0; index < source.size(); index++) {
            JsonNode question = source.get(index);
            closed(question, Set.of("question", "header", "options"), Set.of("multiSelect"));
            text(question.get("header"), Integer.MAX_VALUE, true);
            String prompt = text(question.get("question"), 2048, true);
            require(!question.has("multiSelect") || question.get("multiSelect").isBoolean());
            JsonNode choices = question.get("options");
            require(choices.isArray() && choices.size() >= 2 && choices.size() <= 4);
            String id = "q" + (index + 1);
            ObjectNode item = result.addObject().put("id", id).put("prompt", prompt)
                    .put("required", true).put("multiple", question.path("multiSelect").asBoolean())
                    .put("allowText", true);
            ArrayNode options = item.putArray("options");
            for (int option = 0; option < choices.size(); option++) {
                JsonNode choice = choices.get(option);
                closed(choice, Set.of("label", "description"), Set.of());
                options.addObject().put("id", id + "o" + (option + 1))
                        .put("label", text(choice.get("label"), 256, true))
                        .put("description", text(choice.get("description"), 1024, true));
            }
        }
        require(ManagedEventEnvelopes.canonicalJson(input).getBytes(StandardCharsets.UTF_8).length <= MAX_INPUT_BYTES);
        return result;
    }

    public static void validateQuestions(JsonNode questions) {
        require(questions != null && questions.isArray() && questions.size() >= 1 && questions.size() <= 4);
        for (int index = 0; index < questions.size(); index++) {
            JsonNode question = questions.get(index);
            closed(question, Set.of("id", "prompt", "required", "multiple", "allowText", "options"), Set.of());
            String id = "q" + (index + 1);
            require(id.equals(text(question.get("id"), 128, true))
                    && question.path("required").isBoolean() && question.path("required").booleanValue()
                    && question.path("allowText").isBoolean() && question.path("allowText").booleanValue()
                    && question.path("multiple").isBoolean());
            text(question.get("prompt"), 2048, true);
            JsonNode options = question.get("options");
            require(options.isArray() && options.size() >= 2 && options.size() <= 4);
            for (int option = 0; option < options.size(); option++) {
                JsonNode choice = options.get(option);
                closed(choice, Set.of("id", "label", "description"), Set.of());
                require((id + "o" + (option + 1)).equals(text(choice.get("id"), 128, true)));
                text(choice.get("label"), 256, true);
                text(choice.get("description"), 1024, true);
            }
        }
    }

    public static ArrayNode canonicalAnswers(JsonNode questions, JsonNode answers, boolean publicNames) {
        validateQuestions(questions);
        require(answers != null && answers.isArray() && answers.size() == questions.size());
        String questionKey = publicNames ? "question_id" : "questionId";
        String optionKey = publicNames ? "option_ids" : "optionIds";
        Map<String, JsonNode> byQuestion = new HashMap<>();
        for (JsonNode answer : answers) {
            closed(answer, Set.of(questionKey), Set.of(optionKey, "text"));
            String id = text(answer.get(questionKey), 128, true);
            require(byQuestion.putIfAbsent(id, answer) == null);
        }
        ArrayNode result = JSON.arrayNode();
        for (JsonNode question : questions) {
            String id = question.get("id").textValue();
            JsonNode answer = byQuestion.remove(id);
            require(answer != null);
            Set<String> selected = new HashSet<>();
            if (answer.has(optionKey)) {
                JsonNode options = answer.get(optionKey);
                require(options.isArray() && !options.isEmpty() && options.size() <= 4);
                for (JsonNode option : options) {
                    require(selected.add(text(option, 128, true)));
                }
            }
            String custom = answer.has("text") ? text(answer.get("text"), 8192, true) : null;
            require(!selected.isEmpty() || custom != null);
            require(question.get("multiple").booleanValue() || selected.size() + (custom == null ? 0 : 1) == 1);
            ObjectNode canonical = result.addObject().put("questionId", id);
            if (!selected.isEmpty()) {
                ArrayNode options = canonical.putArray("optionIds");
                for (JsonNode option : question.get("options")) {
                    String optionId = option.get("id").textValue();
                    if (selected.remove(optionId)) {
                        options.add(optionId);
                    }
                }
                require(selected.isEmpty());
            }
            if (custom != null) {
                canonical.put("text", custom);
            }
        }
        require(byQuestion.isEmpty() && answersJson(result).getBytes(StandardCharsets.UTF_8).length <= MAX_ANSWERS_BYTES);
        return result;
    }

    public static String decisionDigest(JsonNode response) {
        return DigestUtils.sha256Hex(decisionJson(response).getBytes(StandardCharsets.UTF_8));
    }

    public static String decisionJson(JsonNode response) {
        return "{\"v\":2,\"answers\":" + answersJson(response.path("answers"))
                + ",\"inputRevision\":" + response.path("inputRevision").longValue()
                + ",\"policyRevision\":" + ManagedEventEnvelopes.canonicalJson(response.path("policyRevision")) + "}";
    }

    private static String answersJson(JsonNode answers) {
        StringBuilder result = new StringBuilder("[");
        for (JsonNode answer : answers) {
            if (result.length() > 1) {
                result.append(',');
            }
            result.append("{\"questionId\":").append(ManagedEventEnvelopes.canonicalJson(answer.get("questionId")));
            if (answer.has("optionIds")) {
                result.append(",\"optionIds\":").append(ManagedEventEnvelopes.canonicalJson(answer.get("optionIds")));
            }
            if (answer.has("text")) {
                result.append(",\"text\":").append(ManagedEventEnvelopes.canonicalJson(answer.get("text")));
            }
            result.append('}');
        }
        return result.append(']').toString();
    }

    private static String text(JsonNode value, int maximum, boolean required) {
        require(value != null && value.isTextual());
        String result = BrokerValues.requireWellFormed(value.textValue(), "Question text");
        require(result.length() <= maximum && (!required || !BLANK.matcher(result).matches()));
        return result;
    }

    private static void closed(JsonNode value, Set<String> required, Set<String> optional) {
        require(value != null && value.isObject() && value.size() >= required.size()
                && value.size() <= required.size() + optional.size());
        require(required.stream().allMatch(value::has));
        value.fieldNames().forEachRemaining(field -> require(required.contains(field) || optional.contains(field)));
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("The structured question or answer is invalid or exceeds its size limit.");
        }
    }
}
