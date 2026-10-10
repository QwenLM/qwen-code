use super::bindings::*;
use core_foundation::{
    attributed_string::{
        CFAttributedStringGetAttributes, CFAttributedStringGetLength, CFAttributedStringGetString,
        CFAttributedStringGetTypeID, CFAttributedStringRef,
    },
    base::{CFGetTypeID, CFRange, CFType, CFTypeRef, TCFType},
    boolean::{CFBoolean, CFBooleanGetTypeID},
    dictionary::{CFDictionaryGetTypeID, CFDictionaryGetValue, CFDictionaryRef},
    number::{kCFNumberDoubleType, CFNumberGetTypeID, CFNumberGetValue},
    string::{CFString, CFStringRef},
    url::{CFURLGetString, CFURLGetTypeID},
};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    static kAXFontTextAttribute: CFStringRef;
    static kAXFontNameKey: CFStringRef;
    static kAXFontSizeKey: CFStringRef;
    static kAXUnderlineTextAttribute: CFStringRef;
    static kAXStrikethroughTextAttribute: CFStringRef;
    static kAXSuperscriptTextAttribute: CFStringRef;
    static kAXLinkTextAttribute: CFStringRef;
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontCreateWithName(name: CFStringRef, size: f64, matrix: CFTypeRef) -> CFTypeRef;
    fn CTFontGetSymbolicTraits(font: CFTypeRef) -> u32;
}

unsafe fn copy_attribute(element: AXUIElementRef, name: &str) -> Option<CFType> {
    let name = CFString::new(name);
    let mut value = std::ptr::null();
    let status = AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value);
    let value = (!value.is_null()).then(|| CFType::wrap_under_create_rule(value));
    (status == kAXErrorSuccess).then_some(value).flatten()
}

unsafe fn string(value: CFTypeRef) -> Option<String> {
    if value.is_null() || CFGetTypeID(value) != CFString::type_id() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(value.cast()).to_string())
}

unsafe fn number(value: CFTypeRef) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return Some(f64::from(bool::from(CFBoolean::wrap_under_get_rule(
            value.cast(),
        ))));
    }
    let mut result = 0.0;
    (CFGetTypeID(value) == CFNumberGetTypeID()
        && CFNumberGetValue(
            value.cast(),
            kCFNumberDoubleType,
            (&mut result as *mut f64).cast(),
        ))
    .then_some(result)
}

unsafe fn attribute(attributes: CFDictionaryRef, key: CFStringRef) -> CFTypeRef {
    CFDictionaryGetValue(attributes, key.cast())
}

pub(super) unsafe fn associated_title(
    element: AXUIElementRef,
    complete: &mut bool,
) -> Option<(super::tree::AXIdentity, Option<String>)> {
    let label = copy_element_attr_with_status(element, "AXTitleUIElement");
    *complete &= label.complete;
    let label = CFType::wrap_under_create_rule(label.value?.cast());
    let element = label.as_CFTypeRef() as AXUIElementRef;
    let title = copy_string_attr_with_status(element, "AXTitle");
    *complete &= title.complete;
    let title = title.value.filter(|value| !value.is_empty()).or_else(|| {
        let value = copy_string_attr_with_status(element, "AXValue");
        *complete &= value.complete;
        value.value.filter(|value| !value.is_empty())
    });
    Some((super::tree::AXIdentity::retained(element), title))
}

pub(super) unsafe fn element_url(element: AXUIElementRef) -> Option<String> {
    let value = copy_attribute(element, "AXURL")?;
    url(value.as_CFTypeRef())
}

unsafe fn url(value: CFTypeRef) -> Option<String> {
    if value.is_null() {
        None
    } else if CFGetTypeID(value) == CFURLGetTypeID() {
        string(CFURLGetString(value.cast()).cast())
    } else {
        string(value)
    }
}

fn escape_markdown(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(character, '\\' | '*' | '_' | '[' | ']' | '<' | '>') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn markdown_destination(url: &str) -> String {
    url.replace('\\', "%5C")
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('\n', "%0A")
        .replace('\r', "%0D")
}

pub(super) fn markdown_link(text: &str, url: &str) -> String {
    format!(
        "[{}](<{}>)",
        escape_markdown(text),
        markdown_destination(url)
    )
}

#[derive(Debug, Clone)]
pub struct RichText {
    pub text: String,
    pub markdown: String,
    pub source_offsets: Vec<usize>,
}

#[derive(Default)]
struct MappedText {
    text: String,
    offsets: Vec<usize>,
}

impl MappedText {
    fn plain(text: &str, escape: bool) -> Self {
        let mut value = Self {
            text: String::new(),
            offsets: vec![0],
        };
        let mut offset = 0;
        for character in text.chars() {
            if escape && matches!(character, '\\' | '*' | '_' | '[' | ']' | '<' | '>') {
                value.text.push('\\');
                value.offsets.push(offset);
            }
            value.text.push(character);
            for _ in 0..character.len_utf16() {
                offset += 1;
                value.offsets.push(offset);
            }
        }
        value
    }

    fn wrap(self, prefix: &str, suffix: &str) -> Self {
        let length = *self.offsets.last().unwrap_or(&0);
        let mut offsets = vec![0; prefix.encode_utf16().count()];
        offsets.extend(self.offsets);
        offsets.extend(std::iter::repeat_n(length, suffix.encode_utf16().count()));
        Self {
            text: format!("{prefix}{}{suffix}", self.text),
            offsets,
        }
    }

    fn append(&mut self, other: Self) {
        let base = *self.offsets.last().unwrap_or(&0);
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        self.text.push_str(&other.text);
        self.offsets.extend(
            other
                .offsets
                .into_iter()
                .skip(1)
                .map(|offset| base + offset),
        );
    }
}

#[derive(Default, PartialEq, Eq)]
struct TextStyle {
    traits: u32,
    underline: bool,
    strikethrough: bool,
    script: i8,
    link: Option<String>,
}

impl TextStyle {
    fn render_mapped(&self, text: &str) -> MappedText {
        let mut rendered = MappedText::default();
        for line in text.split_inclusive('\n') {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                rendered.append(MappedText::plain(line, false));
                continue;
            }
            let start = line.len() - line.trim_start().len();
            let end = start + trimmed.len();
            let mut content = MappedText::plain(trimmed, true);
            if self.traits & 1 != 0 {
                content = content.wrap("*", "*");
            }
            if self.traits & 2 != 0 {
                content = content.wrap("**", "**");
            }
            if self.strikethrough {
                content = content.wrap("~~", "~~");
            }
            if self.underline {
                content = content.wrap("<u>", "</u>");
            }
            if self.script > 0 {
                content = content.wrap("<sup>", "</sup>");
            } else if self.script < 0 {
                content = content.wrap("<sub>", "</sub>");
            }
            if let Some(target) = &self.link {
                content = content.wrap("[", &format!("](<{}>)", markdown_destination(target)));
            }
            rendered.append(MappedText::plain(&line[..start], false));
            rendered.append(content);
            rendered.append(MappedText::plain(&line[end..], false));
        }
        rendered
    }
}

unsafe fn text_style(attributes: CFDictionaryRef) -> TextStyle {
    let mut style = TextStyle::default();
    let font = attribute(attributes, kAXFontTextAttribute);
    if !font.is_null() && CFGetTypeID(font) == CFDictionaryGetTypeID() {
        let name = attribute(font.cast(), kAXFontNameKey);
        if string(name).is_some() {
            let size = number(attribute(font.cast(), kAXFontSizeKey))
                .filter(|size| size.is_finite() && *size > 0.0)
                .unwrap_or(12.0);
            let font = CTFontCreateWithName(name.cast(), size, std::ptr::null());
            if !font.is_null() {
                let font = CFType::wrap_under_create_rule(font);
                style.traits = CTFontGetSymbolicTraits(font.as_CFTypeRef()) & 3;
            }
        }
    }
    style.strikethrough =
        number(attribute(attributes, kAXStrikethroughTextAttribute)).is_some_and(|v| v != 0.0);
    style.underline =
        number(attribute(attributes, kAXUnderlineTextAttribute)).is_some_and(|v| v != 0.0);
    style.script = number(attribute(attributes, kAXSuperscriptTextAttribute))
        .map(|value| {
            if value > 0.0 {
                1
            } else if value < 0.0 {
                -1
            } else {
                0
            }
        })
        .unwrap_or_default();
    let link = attribute(attributes, kAXLinkTextAttribute);
    style.link = if !link.is_null() && CFGetTypeID(link) == AXUIElementGetTypeID() {
        element_url(link as AXUIElementRef)
    } else {
        url(link)
    };
    style
}

unsafe fn render_attributed(value: CFTypeRef) -> Option<RichText> {
    if value.is_null() || CFGetTypeID(value) != CFAttributedStringGetTypeID() {
        return None;
    }
    let attributed = value as CFAttributedStringRef;
    let text = string(CFAttributedStringGetString(attributed).cast())?;
    let utf16 = text.encode_utf16().collect::<Vec<_>>();
    let length = CFAttributedStringGetLength(attributed);
    if length < 0 || length as usize != utf16.len() {
        return None;
    }
    let mut runs: Vec<(TextStyle, String)> = Vec::new();
    let mut index = 0;
    while index < length {
        let mut range = CFRange {
            location: 0,
            length: 0,
        };
        let attributes = CFAttributedStringGetAttributes(attributed, index, &mut range);
        let end = range.location.checked_add(range.length)?;
        if attributes.is_null() || range.location > index || end <= index || end > length {
            return None;
        }
        let run = String::from_utf16(&utf16[index as usize..end as usize]).ok()?;
        let style = text_style(attributes);
        if let Some(previous) = runs.last_mut().filter(|previous| previous.0 == style) {
            previous.1.push_str(&run);
        } else {
            runs.push((style, run));
        }
        index = end;
    }
    let styled = runs.iter().any(|(style, _)| *style != TextStyle::default());
    let mapped = if styled {
        let mut mapped = MappedText::default();
        for (style, run) in runs {
            mapped.append(style.render_mapped(&run));
        }
        mapped
    } else {
        MappedText::plain(&text, false)
    };
    Some(RichText {
        markdown: mapped.text,
        text,
        source_offsets: mapped.offsets,
    })
}

unsafe fn parameterized(
    element: AXUIElementRef,
    name: &str,
    parameter: CFTypeRef,
) -> Option<RichText> {
    let name = CFString::new(name);
    let mut value = std::ptr::null();
    let status = AXUIElementCopyParameterizedAttributeValue(
        element,
        name.as_concrete_TypeRef(),
        parameter,
        &mut value,
    );
    let value = (!value.is_null()).then(|| CFType::wrap_under_create_rule(value));
    if status != kAXErrorSuccess {
        return None;
    }
    render_attributed(value?.as_CFTypeRef())
}

pub(crate) unsafe fn read_rich_text(
    element: AXUIElementRef,
    role: &str,
    value: Option<&str>,
) -> Option<RichText> {
    match role {
        "AXTextArea" => {
            if copy_string_attr(element, "AXTextualContext").as_deref()
                == Some("AXTextualContextSourceCode")
            {
                return None;
            }
            let text = value?;
            let range = CFRange {
                location: 0,
                length: text.encode_utf16().count().try_into().ok()?,
            };
            if range.length == 0 {
                return None;
            }
            let parameter = AXValueCreate(kAXValueCFRangeType, (&range as *const CFRange).cast());
            if parameter.is_null() {
                return None;
            }
            let parameter = CFType::wrap_under_create_rule(parameter.cast());
            let rich = parameterized(
                element,
                "AXAttributedStringForRange",
                parameter.as_CFTypeRef(),
            )?;
            (rich.text == text).then_some(rich)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::{
        attributed_string::{CFAttributedStringSetAttribute, CFMutableAttributedString},
        boolean::CFBoolean,
        dictionary::CFDictionary,
        number::CFNumber,
    };

    #[test]
    fn formatting_maps_visible_utf16_boundaries_to_source() {
        let style = TextStyle {
            traits: 3,
            underline: true,
            link: Some("https://example.com".into()),
            ..Default::default()
        };
        let mapped = style.render_mapped(" A🙂_[中]\nnext ");
        assert_eq!(mapped.offsets.len(), mapped.text.encode_utf16().count() + 1);
        for target in ["A", "🙂", "中", "next"] {
            let start = mapped.text.find(target).unwrap();
            let start = mapped.text[..start].encode_utf16().count();
            let end = start + target.encode_utf16().count();
            let utf16: Vec<_> = " A🙂_[中]\nnext ".encode_utf16().collect();
            assert_eq!(
                String::from_utf16(&utf16[mapped.offsets[start]..mapped.offsets[end]]).unwrap(),
                target
            );
        }
        assert_eq!(
            *mapped.offsets.last().unwrap(),
            " A🙂_[中]\nnext ".encode_utf16().count()
        );
        assert!(mapped.offsets.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn real_attributed_string_runs_preserve_unicode_and_independent_styles() {
        let mut value = CFMutableAttributedString::new();
        value.replace_str(
            &CFString::new("A🙂 中文 end\n"),
            CFRange {
                location: 0,
                length: 0,
            },
        );
        unsafe {
            core_foundation::attributed_string::CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                CFRange {
                    location: 1,
                    length: 2,
                },
                kAXUnderlineTextAttribute,
                CFNumber::from(1).as_CFTypeRef(),
            );
            core_foundation::attributed_string::CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                CFRange {
                    location: 4,
                    length: 2,
                },
                kAXStrikethroughTextAttribute,
                CFBoolean::true_value().as_CFTypeRef(),
            );
            let rendered = render_attributed(value.as_CFTypeRef()).unwrap();
            assert_eq!(rendered.text, "A🙂 中文 end\n");
            assert_eq!(rendered.markdown, "A<u>🙂</u> ~~中文~~ end\n");
        }
    }

    #[test]
    fn unstyled_attributed_text_does_not_add_markdown_escapes() {
        let value = core_foundation::attributed_string::CFAttributedString::new(&CFString::new(
            "  x_[y]*\n",
        ));
        let rendered = unsafe { render_attributed(value.as_CFTypeRef()) }.unwrap();
        assert_eq!(rendered.text, rendered.markdown);
        assert_eq!(rendered.text, "  x_[y]*\n");
    }

    #[test]
    fn links_escape_labels_and_destination_boundaries() {
        assert_eq!(
            markdown_link("[open]*", "https://example.test/a)b>\n"),
            "[\\[open\\]\\*](<https://example.test/a)b%3E%0A>)"
        );
    }

    #[test]
    fn real_font_link_runs_keep_combined_styles_and_ignore_irrelevant_boundaries() {
        let mut value = CFMutableAttributedString::new();
        value.replace_str(
            &CFString::new("  Hello 中文\n"),
            CFRange {
                location: 0,
                length: 0,
            },
        );
        unsafe {
            let font = CFDictionary::from_CFType_pairs(&[
                (
                    CFString::wrap_under_get_rule(kAXFontNameKey).as_CFType(),
                    CFString::new("Helvetica-BoldOblique").as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kAXFontSizeKey).as_CFType(),
                    CFNumber::from(12).as_CFType(),
                ),
            ]);
            let full = CFRange {
                location: 0,
                length: 11,
            };
            CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                full,
                kAXFontTextAttribute,
                font.as_CFTypeRef(),
            );
            CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                full,
                kAXLinkTextAttribute,
                CFString::new("https://example.test/").as_CFTypeRef(),
            );
            CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                CFRange {
                    location: 2,
                    length: 3,
                },
                CFString::new("AXLanguage").as_concrete_TypeRef(),
                CFString::new("en").as_CFTypeRef(),
            );
            let rendered = render_attributed(value.as_CFTypeRef()).unwrap();
            assert_eq!(rendered.text, "  Hello 中文\n");
            assert_eq!(
                rendered.markdown,
                "  [***Hello 中文***](<https://example.test/>)\n"
            );
        }
    }

    #[test]
    fn real_superscript_and_subscript_preserve_distinct_formula_meaning() {
        let mut value = CFMutableAttributedString::new();
        value.replace_str(
            &CFString::new("H2O x2"),
            CFRange {
                location: 0,
                length: 0,
            },
        );
        unsafe {
            for (location, script) in [(1, -1), (5, 1)] {
                CFAttributedStringSetAttribute(
                    value.as_concrete_TypeRef(),
                    CFRange {
                        location,
                        length: 1,
                    },
                    kAXSuperscriptTextAttribute,
                    CFNumber::from(script).as_CFTypeRef(),
                );
            }
            let rendered = render_attributed(value.as_CFTypeRef()).unwrap();
            assert_eq!(rendered.markdown, "H<sub>2</sub>O x<sup>2</sup>");
        }
    }

    #[test]
    fn invalid_unicode_attribute_boundary_falls_back_instead_of_changing_text() {
        let mut value = CFMutableAttributedString::new();
        value.replace_str(
            &CFString::new("🙂"),
            CFRange {
                location: 0,
                length: 0,
            },
        );
        unsafe {
            CFAttributedStringSetAttribute(
                value.as_concrete_TypeRef(),
                CFRange {
                    location: 0,
                    length: 1,
                },
                kAXUnderlineTextAttribute,
                CFNumber::from(1).as_CFTypeRef(),
            );
            assert!(render_attributed(value.as_CFTypeRef()).is_none());
        }
    }
}
