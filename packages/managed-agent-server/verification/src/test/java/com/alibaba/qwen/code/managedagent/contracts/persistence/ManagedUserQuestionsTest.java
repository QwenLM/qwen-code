package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.model.ApiModels;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedUserQuestionsTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private ObjectNode input(boolean multiple) {
        ObjectNode input = JSON.createObjectNode();
        ObjectNode question = input.putArray("questions").addObject().put("question", "Which target?")
                .put("header", "Target").put("multiSelect", multiple);
        question.putArray("options").addObject().put("label", "Same label").put("description", "First choice");
        question.withArray("options").addObject().put("label", "Same label").put("description", "Second choice");
        return input;
    }

    @Test
    void preservesDuplicateLabelsWithStableIdsAndCanonicalizesAnswerOrder() throws Exception {
        ObjectNode input = input(true);
        input.withArray("questions").add(input(false).withArray("questions").get(0));
        ArrayNode questions = ManagedUserQuestions.questionsFromInput(input);
        assertThat(questions.get(0).path("options").get(0).path("id").asText()).isEqualTo("q1o1");
        assertThat(questions.get(1).path("options").get(1).path("id").asText()).isEqualTo("q2o2");
        JsonNode answers = JSON.readTree("""
                [{"questionId":"q2","text":"Custom"},
                 {"text":"And this","optionIds":["q1o2","q1o1"],"questionId":"q1"}]
                """);
        JsonNode canonical = ManagedUserQuestions.canonicalAnswers(questions, answers, false);
        assertThat(canonical.toString()).isEqualTo("[{\"questionId\":\"q1\",\"optionIds\":[\"q1o1\",\"q1o2\"],\"text\":\"And this\"},{\"questionId\":\"q2\",\"text\":\"Custom\"}]");
        ObjectNode response = JSON.createObjectNode().put("inputRevision", 1).put("policyRevision", ManagedUserQuestions.POLICY);
        response.set("answers", canonical);
        String digest = ManagedUserQuestions.decisionDigest(response);
        response.set("answers", ManagedUserQuestions.canonicalAnswers(questions, canonical, false));
        assertThat(ManagedUserQuestions.decisionDigest(response)).isEqualTo(digest);
    }

    @Test
    void publicAndPrivateAnswersProduceIdenticalDecisionBytes() throws Exception {
        ArrayNode questions = ManagedUserQuestions.questionsFromInput(input(false));
        JsonNode publicAnswer = JSON.readTree("[{\"question_id\":\"q1\",\"option_ids\":[\"q1o2\"]}]");
        JsonNode privateAnswer = JSON.readTree("[{\"questionId\":\"q1\",\"optionIds\":[\"q1o2\"]}]");
        assertThat(ManagedUserQuestions.canonicalAnswers(questions, publicAnswer, true))
                .isEqualTo(ManagedUserQuestions.canonicalAnswers(questions, privateAnswer, false));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "[]", "[{}]", "[{\"questionId\":\"q1\"}]", "[{\"questionId\":\"q1\",\"text\":\"\"}]",
            "[{\"questionId\":\"q1\",\"text\":false}]", "[{\"questionId\":\"q1\",\"text\":null}]",
            "[{\"questionId\":\"q1\",\"optionIds\":[]}]", "[{\"questionId\":\"q1\",\"optionIds\":null}]",
            "[{\"questionId\":\"q1\",\"optionIds\":[\"q1o1\",\"q1o1\"]}]",
            "[{\"questionId\":\"q1\",\"optionIds\":[\"q2o1\"]}]",
            "[{\"questionId\":\"q1\",\"optionIds\":[\"q1o1\",\"q1o2\"]}]",
            "[{\"questionId\":\"q1\",\"optionIds\":[\"q1o1\"],\"text\":\"Mixed\"}]",
            "[{\"questionId\":\"other\",\"text\":\"Wrong ID\"}]",
            "[{\"questionId\":\"q1\",\"text\":\"Answer\",\"unexpected\":true}]"
    })
    void refusesMalformedAndAmbiguousAnswers(String body) throws Exception {
        JsonNode answers = JSON.readTree(body);
        assertThatThrownBy(() -> ManagedUserQuestions.canonicalAnswers(
                ManagedUserQuestions.questionsFromInput(input(false)), answers, false)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void refusesDuplicateQuestionsMissingRequiredAnswersAndInvalidUnicode() {
        ObjectNode input = input(true);
        input.withArray("questions").add(input(false).withArray("questions").get(0));
        JsonNode questions = ManagedUserQuestions.questionsFromInput(input);
        ArrayNode duplicate = JSON.createArrayNode();
        duplicate.addObject().put("questionId", "q1").put("text", "First");
        duplicate.addObject().put("questionId", "q1").put("text", "Second");
        assertThatThrownBy(() -> ManagedUserQuestions.canonicalAnswers(questions, duplicate, false)).isInstanceOf(IllegalArgumentException.class);
        ObjectNode invalid = input(false);
        ((ObjectNode) invalid.withArray("questions").get(0)).put("question", "\ud800");
        assertThatThrownBy(() -> ManagedUserQuestions.questionsFromInput(invalid)).isInstanceOf(IllegalArgumentException.class);
        ArrayNode loneSurrogate = JSON.createArrayNode();
        loneSurrogate.addObject().put("questionId", "q1").put("text", "\ud800");
        assertThatThrownBy(() -> ManagedUserQuestions.canonicalAnswers(ManagedUserQuestions.questionsFromInput(input(false)), loneSurrogate, false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void boundsUtf8AggregateInputAndAnswersIndependentlyOfCharacterLimits() {
        ObjectNode oversized = input(false);
        oversized.putObject("metadata").put("source", "中".repeat(6000));
        assertThatThrownBy(() -> ManagedUserQuestions.questionsFromInput(oversized)).isInstanceOf(IllegalArgumentException.class);
        ObjectNode input = input(false);
        input.withArray("questions").add(input(false).withArray("questions").get(0));
        JsonNode questions = ManagedUserQuestions.questionsFromInput(input);
        ArrayNode answers = JSON.createArrayNode();
        answers.addObject().put("questionId", "q1").put("text", "中".repeat(6000));
        answers.addObject().put("questionId", "q2").put("text", "中".repeat(6000));
        assertThatThrownBy(() -> ManagedUserQuestions.canonicalAnswers(questions, answers, false)).isInstanceOf(IllegalArgumentException.class);
        ((ObjectNode) answers.get(1)).put("text", "Short answer");
        assertThatCode(() -> ManagedUserQuestions.canonicalAnswers(questions, answers, false)).doesNotThrowAnyException();
    }

    @Test
    void matchesJavascriptDecisionPropertyOrderUnicodeAndControlEscaping() {
        ObjectNode response = JSON.createObjectNode().put("inputRevision", 1).put("policyRevision", ManagedUserQuestions.POLICY);
        response.putArray("answers").addObject().put("questionId", "q1").put("text", "中😀/\u001b\n\\\"");
        assertThat(ManagedUserQuestions.decisionJson(response)).isEqualTo(
                "{\"v\":2,\"answers\":[{\"questionId\":\"q1\",\"text\":\"中😀/\\u001b\\n\\\\\\\"\"}],\"inputRevision\":1,\"policyRevision\":\"hosted-user-question/1\"}");
    }

    @Test
    void actionResponseDtoRejectsCoercionMixedBranchesAndUnknownFields() throws Exception {
        String valid = "{\"kind\":\"question\",\"input_revision\":1,\"policy_revision\":\"hosted-user-question/1\",\"answers\":[{\"question_id\":\"q1\",\"text\":\"Answer\"}]}";
        assertThat(JSON.readValue(valid, ApiModels.PermissionResponse.class).answers().size()).isEqualTo(1);
        for (String invalid : new String[] {
                valid.replace("\"kind\":\"question\"", "\"kind\":\"permission\""),
                valid.replace("\"input_revision\":1", "\"input_revision\":1,\"option_id\":null"),
                valid.replace("\"policy_revision\":\"hosted-user-question/1\"", "\"policy_revision\":1"),
                valid.replace("\"input_revision\":1", "\"input_revision\":1,\"unexpected\":true")}) {
            assertThatThrownBy(() -> JSON.readValue(invalid, ApiModels.PermissionResponse.class)).isInstanceOf(Exception.class);
        }
        assertThat(new ApiModels.PermissionResponse("permission", JSON.getNodeFactory().numberNode(1), "policy", "allow").answers()).isNull();
    }
}
