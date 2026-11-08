//! Reversible filtering for text crossing the model-facing MCP boundary.

use std::borrow::Cow;
use std::ffi::OsStr;

use serde_json::{Map, Value};

const TOKEN_PREFIX: &str = "__cuaf_";
const TOKEN_SUFFIX: &str = "__";

const FILTER_ENV: &str = "MCP_MODEL_PAYLOAD_FILTER";

pub(crate) fn is_enabled() -> bool {
    is_enabled_value(std::env::var_os(FILTER_ENV).as_deref())
}

fn is_enabled_value(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

const ASCII_TERMS: &[&str] = &[
    "qwen",
    "dashscope",
    "alibaba",
    "aliyun",
    "aliyuncs",
    "alicloud",
    "tongyi",
    "qianwen",
    "bailian",
    "modelscope",
    "damo",
    "lingma",
    "wanx",
    "alipay",
    "antfin",
    "yuque",
    "dingtalk",
    "taobao",
    "tmall",
    "qoder",
    "maxcompute",
];

const CHINESE_TERMS: &[&str] = &[
    "通义",
    "千问",
    "阿里",
    "百炼",
    "魔搭",
    "达摩",
    "灵码",
    "万相",
    "支付宝",
    "蚂蚁",
    "语雀",
    "钉钉",
    "淘宝",
    "天猫",
];

const SEPARATOR_PATTERNS: &[(&str, &str)] = &[
    ("q", "wen"),
    ("dash", "scope"),
    ("ali", "baba"),
    ("ali", "yun"),
    ("ali", "cloud"),
    ("tong", "yi"),
    ("qian", "wen"),
    ("ant", "group"),
];

/// Encode filtered substrings without hiding the surrounding text. The token
/// contains only a reserved prefix plus hexadecimal UTF-8 bytes, so it can be
/// returned as a later tool argument and decoded without process-local state.
pub(crate) fn encode_text(input: &str) -> Cow<'_, str> {
    let mut output: Option<String> = None;
    let mut offset = 0;

    while offset < input.len() {
        let tail = &input[offset..];
        let matched_len = if tail.starts_with(TOKEN_PREFIX) {
            Some(TOKEN_PREFIX.len())
        } else {
            filtered_match_len(tail)
        };

        if let Some(len) = matched_len {
            let out = output.get_or_insert_with(|| {
                let mut out = String::with_capacity(input.len() + 16);
                out.push_str(&input[..offset]);
                out
            });
            push_token(out, &input.as_bytes()[offset..offset + len]);
            offset += len;
            continue;
        }

        let ch = tail.chars().next().expect("non-empty tail");
        if let Some(out) = output.as_mut() {
            out.push(ch);
        }
        offset += ch.len_utf8();
    }

    match output {
        Some(output) => Cow::Owned(output),
        None => Cow::Borrowed(input),
    }
}

/// Decode aliases previously produced by [`encode_text`]. Malformed tokens
/// remain literal text. Decoding is deliberately one pass: an escaped literal
/// token prefix must be restored as data, not interpreted a second time.
pub(crate) fn decode_text(input: &str) -> Cow<'_, str> {
    let mut output: Option<String> = None;
    let mut copied_through = 0;
    let mut search_from = 0;

    while let Some(relative_start) = input[search_from..].find(TOKEN_PREFIX) {
        let start = search_from + relative_start;
        let hex_start = start + TOKEN_PREFIX.len();
        let Some(relative_end) = input[hex_start..].find(TOKEN_SUFFIX) else {
            break;
        };
        let hex_end = hex_start + relative_end;
        let token_end = hex_end + TOKEN_SUFFIX.len();

        let Some(decoded) = decode_hex(&input[hex_start..hex_end]) else {
            search_from = hex_start;
            continue;
        };

        let out = output.get_or_insert_with(|| String::with_capacity(input.len()));
        out.push_str(&input[copied_through..start]);
        out.push_str(&decoded);
        copied_through = token_end;
        search_from = token_end;
    }

    match output {
        Some(mut output) => {
            output.push_str(&input[copied_through..]);
            Cow::Owned(output)
        }
        None => Cow::Borrowed(input),
    }
}

/// Encode every textual key and value in an MCP result. Base64 media data is
/// opaque and must stay byte-for-byte identical.
pub(crate) fn encode_value(value: &mut Value) {
    transform_value(value, Direction::Encode).expect("encoding is infallible");
}

/// Decode aliases in a tool name/argument value before schema validation and
/// dispatch. A hostile payload can manufacture aliases that collapse two keys;
/// reject that input instead of silently discarding one value.
pub(crate) fn decode_value(value: &mut Value) -> Result<(), String> {
    transform_value(value, Direction::Decode)
}

#[derive(Clone, Copy)]
enum Direction {
    Encode,
    Decode,
}

fn transform_value(value: &mut Value, direction: Direction) -> Result<(), String> {
    match value {
        Value::String(text) => {
            let transformed = match direction {
                Direction::Encode => encode_text(text),
                Direction::Decode => decode_text(text),
            };
            if let Cow::Owned(transformed) = transformed {
                *text = transformed;
            }
        }
        Value::Array(items) => {
            for item in items {
                transform_value(item, direction)?;
            }
        }
        Value::Object(object) => {
            let opaque_data = matches!(
                object.get("type").and_then(Value::as_str),
                Some("image" | "audio")
            );
            let original = std::mem::take(object);
            let mut transformed = Map::with_capacity(original.len());

            for (key, mut child) in original {
                let transformed_key = match direction {
                    Direction::Encode => encode_text(&key).into_owned(),
                    Direction::Decode => decode_text(&key).into_owned(),
                };
                if !(opaque_data && key == "data") {
                    transform_value(&mut child, direction)?;
                }
                if transformed.insert(transformed_key, child).is_some() {
                    return Err("decoded payload contains duplicate object keys".to_owned());
                }
            }
            *object = transformed;
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn filtered_match_len(tail: &str) -> Option<usize> {
    let mut longest = None;

    for term in ASCII_TERMS.iter().chain(CHINESE_TERMS) {
        if tail
            .get(..term.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(term))
        {
            longest = Some(longest.map_or(term.len(), |len: usize| len.max(term.len())));
        }
    }

    for (first, second) in SEPARATOR_PATTERNS {
        let Some(first_candidate) = tail.get(..first.len()) else {
            continue;
        };
        if !first_candidate.eq_ignore_ascii_case(first) {
            continue;
        }

        let mut second_start = first.len();
        if matches!(
            tail.as_bytes().get(second_start).copied(),
            Some(b'-' | b'_' | b' ')
        ) {
            second_start += 1;
        }
        let second_end = second_start + second.len();
        if tail
            .get(second_start..second_end)
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(second))
        {
            longest = Some(longest.map_or(second_end, |len: usize| len.max(second_end)));
        }
    }

    longest
}

fn push_token(output: &mut String, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    output.push_str(TOKEN_PREFIX);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output.push_str(TOKEN_SUFFIX);
}

fn decode_hex(hex: &str) -> Option<String> {
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        bytes.push((high << 4) | low);
    }
    String::from_utf8(bytes).ok()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_round_trip(input: &str) {
        let encoded = encode_text(input);
        assert_ne!(encoded, input, "expected a filtered match in {input:?}");
        assert_eq!(decode_text(&encoded), input);
        assert!(
            !contains_filtered_term(&encoded),
            "encoded text still contains a filtered term: {encoded}"
        );
    }

    fn contains_filtered_term(text: &str) -> bool {
        let mut offset = 0;
        while offset < text.len() {
            let tail = &text[offset..];
            if filtered_match_len(tail).is_some() {
                return true;
            }
            offset += tail.chars().next().expect("non-empty tail").len_utf8();
        }
        false
    }

    #[test]
    fn filter_opt_in_requires_exact_one() {
        assert!(!is_enabled_value(None));
        for value in ["", "0", "01", "true", "TRUE", "yes", " 1"] {
            assert!(!is_enabled_value(Some(OsStr::new(value))));
        }
        assert!(is_enabled_value(Some(OsStr::new("1"))));
    }

    #[test]
    fn filters_every_canonical_term_case_insensitively() {
        for term in ASCII_TERMS {
            assert_round_trip(term);
            assert_round_trip(&term.to_ascii_uppercase());
        }
        for term in CHINESE_TERMS {
            assert_round_trip(term);
        }
    }

    #[test]
    fn filters_supported_separator_variants() {
        for (first, second) in SEPARATOR_PATTERNS {
            for separator in ["", "-", "_", " "] {
                assert_round_trip(&format!("{first}{separator}{second}"));
            }
        }
        assert_round_trip("DaSh_ScOpE");
        assert_round_trip("QIAN-WEN");
        assert_round_trip("Ant Group");
    }

    #[test]
    fn preserves_surrounding_text_and_multiple_matches() {
        let input = "Open Q-Wen in 阿里 Cloud, then inspect Dash_Scope.";
        let encoded = encode_text(input);
        assert!(encoded.starts_with("Open "));
        assert!(encoded.contains(" in "));
        assert!(encoded.ends_with('.'));
        assert_eq!(decode_text(&encoded), input);
        assert!(!contains_filtered_term(&encoded));
    }

    #[test]
    fn escapes_a_literal_token_prefix() {
        let input = "literal __cuaf_5177656E__ text";
        let encoded = encode_text(input);
        assert_ne!(encoded, input);
        assert_eq!(decode_text(&encoded), input);
    }

    #[test]
    fn leaves_invalid_tokens_literal() {
        for input in ["__cuaf___", "__cuaf_0__", "__cuaf_ZZ__", "__cuaf_FF__"] {
            assert_eq!(decode_text(input), input);
        }
    }

    #[test]
    fn recursively_transforms_keys_and_values_but_not_media_data() {
        let mut value = json!({
            "QwenKey": {
                "path": "/Applications/Alibaba Cloud/Qwen.app",
                "nested": ["通义", { "Dash Scope": "百炼" }]
            },
            "content": [
                {
                    "type": "image",
                    "data": "Qwen-DashScope-Alibaba",
                    "annotations": { "label": "Ali Cloud" }
                },
                {
                    "type": "audio",
                    "data": "Qwen-DashScope-Alibaba"
                }
            ]
        });
        let original = value.clone();

        encode_value(&mut value);

        assert!(value.get("QwenKey").is_none());
        assert_eq!(value["content"][0]["data"], original["content"][0]["data"]);
        assert_eq!(value["content"][1]["data"], original["content"][1]["data"]);
        assert_ne!(
            value["content"][0]["annotations"]["label"],
            original["content"][0]["annotations"]["label"]
        );

        decode_value(&mut value).expect("decode");
        assert_eq!(value, original);
    }

    #[test]
    fn decoding_rejects_object_key_collisions() {
        let encoded_key = encode_text("Qwen").into_owned();
        let mut value = json!({ "Qwen": 1 });
        value.as_object_mut().unwrap().insert(encoded_key, json!(2));

        assert!(decode_value(&mut value).is_err());
    }

    #[test]
    fn filters_driver_identity_from_observed_windows_apps_and_tree_shapes() {
        let mut value = json!({
            "content": [{
                "type": "text",
                "text": "[{\"app_name\":\"qwen-cua-driver.exe\"}]"
            }],
            "structuredContent": {
                "windows": [{ "app_name": "qwen-cua-driver.exe" }],
                "apps": [{ "name": "qwen-cua-driver.exe" }],
                "processes": [{ "name": "qwen-cua-driver.exe", "pid": 7756 }]
            }
        });
        let original = value.clone();

        encode_value(&mut value);

        let wire = serde_json::to_string(&value).expect("serialize filtered payload");
        assert!(!wire.to_ascii_lowercase().contains("qwen"));
        decode_value(&mut value).expect("decode");
        assert_eq!(value, original);
    }

    #[test]
    fn safe_text_is_borrowed_and_unchanged() {
        let input = "ordinary cua-driver payload";
        assert!(matches!(encode_text(input), Cow::Borrowed(_)));
        assert!(matches!(decode_text(input), Cow::Borrowed(_)));
    }
}
