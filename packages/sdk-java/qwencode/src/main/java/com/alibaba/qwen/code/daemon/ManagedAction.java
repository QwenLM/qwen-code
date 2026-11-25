package com.alibaba.qwen.code.daemon;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A permission or question action that can be answered by a caller. */
public final class ManagedAction extends ManagedJson {
    ManagedAction(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getSessionId() {
        return string("session_id");
    }

    public String getTurnId() {
        return optionalString("turn_id");
    }

    public String getKind() {
        return string("kind");
    }

    public String getState() {
        return string("state");
    }

    public long getInputRevision() {
        return number("input_revision");
    }

    public String getPolicyRevision() {
        return string("policy_revision");
    }

    public long getCreatedAt() {
        return number("created_at");
    }

    public long getExpiresAt() {
        return number("expires_at");
    }

    public String getDecisionReceiptId() {
        return optionalString("decision_receipt_id");
    }

    public String getFunctionCallId() {
        return string("function_call_id");
    }

    public String getToolName() {
        return string("tool_name");
    }

    public Source getSource() {
        return new Source(object("source"));
    }

    public Preview getInputPreview() {
        return optionalObject("input_preview", Preview::new);
    }

    public List<Option> getOptions() {
        return json().get("options") == null ? List.of() : objects("options", Option::new);
    }

    public List<Question> getQuestions() {
        return json().get("questions") == null ? List.of() : objects("questions", Question::new);
    }

    /** Origin of the action. */
    public static final class Source extends ManagedJson {
        Source(Map<String, Object> json) {
            super(json);
        }

        public String getKind() {
            return string("kind");
        }

        public String getId() {
            return string("id");
        }
    }

    /** One selectable option. */
    public static final class Option extends ManagedJson {
        Option(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("id");
        }

        public String getLabel() {
            return optionalString("label");
        }

        public String getDescription() {
            return optionalString("description");
        }
    }

    /** One question and its response constraints. */
    public static final class Question extends ManagedJson {
        Question(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("id");
        }

        public String getPrompt() {
            return optionalString("prompt");
        }

        public boolean isRequired() {
            return flag("required");
        }

        public boolean allowsMultiple() {
            return flag("multiple");
        }

        public boolean allowsText() {
            return flag("allow_text");
        }

        public List<Option> getOptions() {
            return objects("options", Option::new);
        }
    }

    /** Optional UTF-8 preview of the tool input. */
    public static final class Preview extends ManagedJson {
        Preview(Map<String, Object> json) {
            super(json);
        }

        public String getText() {
            return optionalString("text");
        }

        public boolean isTruncated() {
            return flag("truncated");
        }

        public long getByteLength() {
            return number("byte_length");
        }
    }

    /** One response to a question. Text and option IDs are allowed according to the question. */
    public static final class Answer {
        private final Map<String, Object> json;

        public Answer(String questionId, List<String> optionIds, String text) {
            json = new LinkedHashMap<>(Map.of("question_id", questionId));
            if (optionIds != null) {
                json.put("option_ids", List.copyOf(optionIds));
            }
            ManagedJson.put(json, "text", text);
        }

        Map<String, Object> toJson() {
            return json;
        }
    }
}
