use super::tree::AXNode;

struct Branch {
    node: AXNode,
    children: Vec<Branch>,
}

fn label(node: &AXNode) -> &str {
    node.title
        .as_deref()
        .or(node.description.as_deref())
        .or(node.value.as_deref())
        .or(node.identifier.as_deref())
        .unwrap_or_default()
}

fn protected(node: &AXNode) -> bool {
    node.element_index.is_some()
        || node.focusable_or_selectable
        || node.selectable
        || node.focused == Some(true)
        || node.selected == Some(true)
        || !node.actions.is_empty()
}

fn label_only(node: &AXNode) -> bool {
    node.enabled != Some(false)
        && node.help.is_none()
        && node.identifier.is_none()
        && node.value_description.is_none()
        && node.rich_text.is_none()
        && node.url.is_none()
        && node.selected != Some(true)
        && node.min_value.is_none()
        && node.max_value.is_none()
        && [
            node.title.as_deref(),
            node.description.as_deref(),
            node.value.as_deref(),
            node.value_state.as_deref(),
        ]
        .into_iter()
        .flatten()
        .all(|value| value == label(node))
}

fn text_only(branch: &Branch) -> bool {
    branch.node.role == "AXStaticText"
        && branch.children.is_empty()
        && !protected(&branch.node)
        && label_only(&branch.node)
}

pub(crate) fn app_action_is_interesting(
    action: &str,
    role: &str,
    value_settable: bool,
    has_scrollbar: impl FnOnce(&str) -> bool,
) -> bool {
    match action {
        "AXShowAlternateUI" | "AXShowDefaultUI" => false,
        "AXCancel" if matches!(role, "AXMenuBar" | "AXMenuItem") => false,
        "AXPick" if role == "AXMenuItem" => false,
        "AXConfirm" if role == "AXTextField" => false,
        "AXIncrement" | "AXDecrement" if value_settable => false,
        "AXScrollLeftByPage" | "AXScrollRightByPage" => has_scrollbar("AXHorizontalScrollBar"),
        "AXScrollUpByPage" | "AXScrollDownByPage" => has_scrollbar("AXVerticalScrollBar"),
        _ => true,
    }
}

fn project(branch: Branch) -> Vec<Branch> {
    let Branch {
        mut node,
        mut children,
    } = branch;
    let associated_titles = children
        .iter()
        .filter_map(|child| {
            child.node.title_ui_element.as_ref().map(|identity| {
                (
                    identity.clone(),
                    label(&child.node).to_owned(),
                    child.node.in_web_content,
                )
            })
        })
        .collect::<Vec<_>>();
    children.retain(|child| {
        !text_only(child)
            || !associated_titles.iter().any(|(identity, title, web)| {
                child.node.identity.as_ref() == Some(identity)
                    && label(&child.node) == title
                    && child.node.in_web_content == *web
            })
    });
    let children = children
        .into_iter()
        .flat_map(|child| project(child))
        .collect::<Vec<_>>();
    let mut merged: Vec<Branch> = Vec::new();
    for child in children {
        if text_only(&child)
            && child.node.in_web_content == node.in_web_content
            && label(&child.node) == label(&node)
            && !label(&node).is_empty()
        {
            continue;
        }
        if text_only(&child) {
            if let Some(previous) = merged.last_mut().filter(|previous| {
                text_only(previous) && previous.node.in_web_content == child.node.in_web_content
            }) {
                let text = format!("{}\n{}", label(&previous.node), label(&child.node));
                previous.node.title = None;
                previous.node.description = None;
                previous.node.value = Some(text);
                previous.node.value_state = None;
                continue;
            }
        }
        merged.push(child);
    }
    if merged.len() == 1
        && text_only(&merged[0])
        && merged[0].node.in_web_content == node.in_web_content
        && node
            .rich_text
            .as_ref()
            .is_some_and(|text| text.text == label(&merged[0].node))
    {
        merged.clear();
    }
    if node.selectable
        && node.focused != Some(true)
        && node.role != "AXTable"
        && !node.table_row
        && node.rich_text.is_none()
        && node.url.is_none()
        && !merged.is_empty()
        && merged
            .iter()
            .all(|child| text_only(child) && child.node.in_web_content == node.in_web_content)
        && node
            .value_state
            .as_deref()
            .is_none_or(|value| Some(value) == node.value.as_deref())
        && node.min_value.is_none()
        && node.max_value.is_none()
    {
        let mut values = node.value.iter().cloned().collect::<Vec<_>>();
        for child in &merged {
            let text = label(&child.node);
            if text != label(&node) && !values.iter().any(|value| value == text) {
                values.push(text.to_owned());
            }
        }
        if !values.is_empty() {
            node.value = Some(values.join("\n"));
            node.value_state = node.value.clone();
        }
        merged.clear();
    }
    let descriptive = !label(&node).is_empty()
        || node
            .value_state
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || node.help.is_some()
        || node.value_description.is_some()
        || node
            .rich_text
            .as_ref()
            .is_some_and(|text| !text.text.is_empty())
        || node.url.is_some()
        || node.selected == Some(true)
        || node.min_value.is_some()
        || node.max_value.is_some();
    let layout = matches!(
        node.role.as_str(),
        "AXGroup" | "AXScrollArea" | "AXLayoutArea" | "AXUnknown"
    );
    if !protected(&node) && !descriptive && layout && node.enabled != Some(false) {
        return merged;
    }
    if !protected(&node)
        && node.role == "AXGroup"
        && label_only(&node)
        && merged.len() == 1
        && merged[0].node.in_web_content == node.in_web_content
        && label(&merged[0].node) == label(&node)
    {
        return merged;
    }
    let context = matches!(
        node.role.as_str(),
        "AXWindow"
            | "AXSheet"
            | "AXWebArea"
            | "AXMenu"
            | "AXMenuBar"
            | "AXTable"
            | "AXOutline"
            | "AXList"
    );
    if node.enabled == Some(false)
        && node.focused != Some(true)
        && node.element_index.is_none()
        && !descriptive
        && merged.is_empty()
        && !context
    {
        return Vec::new();
    }
    if !protected(&node) && !descriptive && merged.is_empty() && !context {
        return Vec::new();
    }
    // All addressable nodes survive projection, so their retained pointers and
    // snapshot indices remain in the same order as the native element cache.
    node.depth = 0;
    vec![Branch {
        node,
        children: merged,
    }]
}

pub(crate) fn project_app_nodes(nodes: Vec<AXNode>) -> Vec<AXNode> {
    fn collect(
        input: &mut std::iter::Peekable<std::vec::IntoIter<AXNode>>,
        depth: usize,
    ) -> Vec<Branch> {
        let mut branches = Vec::new();
        while input.peek().is_some_and(|node| node.depth >= depth) {
            let node = input.next().expect("peeked");
            let children = collect(input, node.depth + 1);
            branches.push(Branch { node, children });
        }
        branches
    }
    fn flatten(branch: Branch, depth: usize, parent: Option<usize>, out: &mut Vec<AXNode>) {
        let Branch { mut node, children } = branch;
        node.depth = depth;
        node.parent_element_index = parent;
        let parent = node.element_index.or(parent);
        out.push(node);
        for child in children {
            flatten(child, depth + 1, parent, out);
        }
    }
    let roots = collect(&mut nodes.into_iter().peekable(), 0);
    let mut result = Vec::new();
    for root in roots.into_iter().flat_map(project) {
        flatten(root, 0, None, &mut result);
    }
    result
}

pub(crate) fn format_app_body(node: &AXNode) -> String {
    let raw_label = label(node);
    let rich = node.rich_text.as_ref();
    let rich_label = rich
        .filter(|text| text.text == raw_label)
        .map(|text| text.markdown.as_str());
    let linked_label = node
        .url
        .as_ref()
        .map(|url| super::app_text::markdown_link(raw_label, url));
    let label = linked_label.as_deref().or(rich_label).unwrap_or(raw_label);
    let quote = |value: &str| serde_json::to_string(value).expect("string serializes");
    let mut fields = vec![
        node.role
            .strip_prefix("AX")
            .unwrap_or(&node.role)
            .to_owned(),
        quote(label),
    ];
    if let Some(value) = rich
        .map(|text| text.markdown.as_str())
        .or(node.value_state.as_deref())
        .or(node.value.as_deref())
        .filter(|value| !value.is_empty() && *value != label && *value != raw_label)
    {
        fields.push(format!("value={}", quote(value)));
    }
    for (key, value) in [
        ("description", node.description.as_deref()),
        ("help", node.help.as_deref()),
        ("value_description", node.value_description.as_deref()),
    ] {
        if let Some(value) =
            value.filter(|value| !value.is_empty() && *value != raw_label && *value != label)
        {
            fields.push(format!("{key}={}", quote(value)));
        }
    }
    if linked_label.is_some() || rich.is_some_and(|text| text.markdown != text.text) {
        fields.push("content_format=markdown".to_owned());
    }
    if node.enabled == Some(false) {
        fields.push("disabled".to_owned());
    }
    if node.focused == Some(true) {
        fields.push("focused".to_owned());
    }
    if node.selected == Some(true) {
        fields.push("selected".to_owned());
    }
    if let (Some(min), Some(max)) = (node.min_value, node.max_value) {
        let binary_control = min == 0.0
            && max == 1.0
            && matches!(
                node.role.as_str(),
                "AXButton" | "AXMenuButton" | "AXCheckBox" | "AXRadioButton"
            );
        if min.is_finite() && max.is_finite() && max > min && !binary_control {
            fields.push(format!("range={min}..{max}"));
        }
    }
    let mut seen_actions = std::collections::HashSet::new();
    let secondary = node
        .actions
        .iter()
        .filter(|action| {
            !matches!(action.as_str(), "AXPress" | "AXPick") && seen_actions.insert(action.as_str())
        })
        .map(|action| action.strip_prefix("AX").unwrap_or(action))
        .collect::<Vec<_>>();
    if !secondary.is_empty() {
        fields.push(format!(
            "actions={}",
            serde_json::to_string(&secondary).expect("actions serialize")
        ));
    }
    if node.in_web_content {
        fields.push("in_web_content=true".to_owned());
    }
    fields.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, title: &str, depth: usize, index: Option<usize>) -> AXNode {
        AXNode {
            role: role.into(),
            title: (!title.is_empty()).then(|| title.into()),
            depth,
            element_index: index,
            ..Default::default()
        }
    }

    #[test]
    fn containers_collapse_without_losing_controls_or_action_ancestry() {
        let nodes = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            node("AXGroup", "", 1, None),
            node("AXButton", "Save", 2, Some(0)),
            node("AXStaticText", "Save", 3, None),
            node("AXGroup", "", 3, None),
            node("AXButton", "More", 4, Some(1)),
            node("AXGroup", "Account", 1, None),
            node("AXTextField", "Name", 2, Some(2)),
        ]);
        assert_eq!(
            nodes
                .iter()
                .map(|node| (node.role.as_str(), node.depth, node.parent_element_index))
                .collect::<Vec<_>>(),
            vec![
                ("AXWindow", 0, None),
                ("AXButton", 1, None),
                ("AXButton", 2, Some(0)),
                ("AXGroup", 1, None),
                ("AXTextField", 2, None),
            ]
        );
        assert_eq!(
            nodes
                .iter()
                .filter_map(|node| node.element_index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn disabled_descriptions_focus_and_selectability_survive() {
        let mut disabled = node("AXMenuItem", "Paste", 1, None);
        disabled.enabled = Some(false);
        let mut focused = node("AXGroup", "", 1, None);
        focused.focused = Some(true);
        let mut selectable = node("AXGroup", "", 1, None);
        selectable.focusable_or_selectable = true;
        let mut empty = node("AXMenuItem", "", 1, None);
        empty.enabled = Some(false);
        let mut numeric = node("AXGroup", "", 1, None);
        numeric.value_state = Some("0".into());
        let nodes = project_app_nodes(vec![
            node("AXMenu", "Edit", 0, None),
            disabled,
            focused,
            selectable,
            empty,
            numeric,
        ]);
        assert_eq!(nodes.len(), 5);
        assert!(format_app_body(&nodes[1]).contains("Paste\" disabled"));
        assert_eq!(nodes[2].focused, Some(true));
        assert!(nodes[3].focusable_or_selectable);
        assert!(format_app_body(&nodes[4]).contains("value=\"0\""));
    }

    #[test]
    fn only_plain_text_siblings_merge_and_web_trust_is_preserved() {
        let mut link = node("AXStaticText", "third", 1, None);
        link.in_web_content = true;
        let mut help = node("AXStaticText", "fourth", 1, None);
        help.help = Some("Details".into());
        let nodes = project_app_nodes(vec![
            node("AXWindow", "Doc", 0, None),
            node("AXStaticText", "first", 1, None),
            node("AXStaticText", "second", 1, None),
            link,
            help,
        ]);
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[1].value.as_deref(), Some("first\nsecond"));
        assert!(nodes[2].in_web_content);
        assert_eq!(nodes[3].help.as_deref(), Some("Details"));
    }

    #[test]
    fn compact_rendering_preserves_literal_text_and_meaningful_state() {
        let literal = "Keep \"frame=1,2 element_token=example\" and \\ paths";
        let mut node = node("AXCheckBox", literal, 0, Some(0));
        node.value_state = Some("0".into());
        node.enabled = Some(false);
        node.selected = Some(false);
        node.actions = vec!["AXPress".into(), "AXShowMenu".into()];
        node.frame = Some([1.0, 2.0, 3.0, 4.0]);
        let text = format_app_body(&node);
        assert!(text.contains(&serde_json::to_string(literal).unwrap()));
        assert!(text.contains("value=\"0\" disabled"));
        assert!(!text.contains("selected=false"));
        assert!(text.contains("ShowMenu"));
        assert!(!text.contains("frame=1,2,3,4"));
        assert!(!text.contains("AXPress"));
    }

    #[test]
    fn stateful_static_text_survives_deduplication_and_sibling_merging() {
        let mut status = node("AXStaticText", "Progress", 1, None);
        status.value_state = Some("42".into());
        let mut range = node("AXStaticText", "Scale", 1, None);
        range.min_value = Some(0.0);
        range.max_value = Some(100.0);
        let projected = project_app_nodes(vec![
            node("AXWindow", "Progress", 0, None),
            status,
            node("AXStaticText", "Remaining", 1, None),
            range,
        ]);
        assert_eq!(projected.len(), 4);
        assert!(format_app_body(&projected[1]).contains("value=\"42\""));
        assert!(format_app_body(&projected[3]).contains("range=0..100"));
    }

    #[test]
    fn empty_subtrees_prune_but_actions_and_context_survive() {
        let projected = project_app_nodes(vec![
            node("AXWindow", "", 0, None),
            node("AXImage", "", 1, None),
            node("AXButton", "", 2, None),
            node("AXImage", "", 1, None),
            node("AXButton", "", 2, Some(0)),
            node("AXSheet", "", 1, None),
        ]);
        assert_eq!(projected.len(), 4);
        assert_eq!(projected[0].role, "AXWindow");
        assert_eq!(projected[1].role, "AXImage");
        assert_eq!(projected[2].element_index, Some(0));
        assert_eq!(projected[3].role, "AXSheet");
    }

    #[test]
    fn duplicate_group_label_collapses_without_remapping_its_child() {
        let projected = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            node("AXGroup", "Account", 1, None),
            node("AXButton", "Account", 2, Some(4)),
        ]);
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[1].element_index, Some(4));
        assert_eq!(projected[1].depth, 1);
    }

    #[test]
    fn projection_changes_reach_revision_instead_of_reporting_no_change() {
        use cua_driver_core::observation_revision::{
            CapturedNode, ObservationLineage, ObservationMode,
        };
        let capture = |value: &str| {
            let mut status = node("AXStaticText", "Progress", 1, None);
            status.value_state = Some(value.into());
            project_app_nodes(vec![node("AXWindow", "Progress", 0, None), status])
                .into_iter()
                .enumerate()
                .map(|(identity, node)| CapturedNode {
                    identity,
                    depth: node.depth,
                    body: format_app_body(&node),
                    actionable_index: node.element_index,
                })
                .collect()
        };
        let mut lineage = ObservationLineage::new("state-projection", 8)
            .unwrap()
            .for_app();
        let before = lineage.observe(capture("41"), None, false).unwrap();
        let after = lineage
            .observe(capture("42"), Some(&before.revision_id), false)
            .unwrap();
        assert_ne!(after.mode, ObservationMode::NoChange);
        assert!(after.text.contains("42"));
    }

    #[test]
    fn app_action_filter_preserves_navigation_and_custom_capabilities() {
        for action in ["AXShowAlternateUI", "AXShowDefaultUI"] {
            assert!(!app_action_is_interesting(
                action,
                "AXButton",
                false,
                |_| true
            ));
        }
        for action in [
            "AXPress",
            "AXPick",
            "AXCancel",
            "AXShowMenu",
            "AXRaise",
            "AXScrollLeftByPage",
            "AXScrollUpByPage",
            "CustomAction",
        ] {
            assert!(app_action_is_interesting(action, "AXButton", false, |_| {
                true
            }));
        }
    }

    #[test]
    fn native_action_roles_and_value_capabilities_control_secondary_descriptions() {
        for (action, role) in [
            ("AXCancel", "AXMenuBar"),
            ("AXCancel", "AXMenuItem"),
            ("AXPick", "AXMenuItem"),
            ("AXConfirm", "AXTextField"),
        ] {
            assert!(!app_action_is_interesting(action, role, false, |_| panic!(
                "no scroll lookup"
            )));
            assert!(app_action_is_interesting(
                action,
                "AXButton",
                false,
                |_| panic!("no scroll lookup")
            ));
        }
        for action in ["AXIncrement", "AXDecrement"] {
            assert!(!app_action_is_interesting(
                action,
                "AXScrollBar",
                true,
                |_| false
            ));
            assert!(app_action_is_interesting(
                action,
                "AXScrollBar",
                false,
                |_| false
            ));
        }
        for (action, axis) in [
            ("AXScrollLeftByPage", "AXHorizontalScrollBar"),
            ("AXScrollRightByPage", "AXHorizontalScrollBar"),
            ("AXScrollUpByPage", "AXVerticalScrollBar"),
            ("AXScrollDownByPage", "AXVerticalScrollBar"),
        ] {
            assert!(app_action_is_interesting(
                action,
                "AXScrollArea",
                false,
                |attribute| attribute == axis
            ));
            assert!(!app_action_is_interesting(
                action,
                "AXScrollArea",
                false,
                |_| false
            ));
        }
    }

    #[test]
    fn labelled_group_keeps_extra_state_and_distinct_children() {
        let mut group = node("AXGroup", "Account", 1, None);
        group.help = Some("Choose an account".into());
        let projected = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            group,
            node("AXButton", "Account", 2, Some(0)),
            node("AXGroup", "Billing", 1, None),
            node("AXButton", "Account", 2, Some(1)),
        ]);
        assert_eq!(projected.len(), 5);
        assert_eq!(projected[1].help.as_deref(), Some("Choose an account"));
    }

    #[test]
    fn libreoffice_default_flags_do_not_keep_empty_layout_or_repeat_actions() {
        let mut group = node("AXGroup", "", 1, None);
        group.selected = Some(false);
        let mut button = node("AXMenuButton", "Open", 2, Some(0));
        button.selected = Some(false);
        button.min_value = Some(0.0);
        button.max_value = Some(1.0);
        let mut scroll = node("AXScrollBar", "Vertical scroll bar", 1, Some(1));
        scroll.actions = vec![
            "AXDecrement".into(),
            "AXIncrement".into(),
            "AXDecrement".into(),
            "AXIncrement".into(),
        ];
        scroll.min_value = Some(0.0);
        scroll.max_value = Some(16408.0);
        let projected = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            group,
            button,
            scroll,
        ]);
        assert_eq!(projected.len(), 3);
        assert_eq!(projected[1].depth, 1);
        assert_eq!(projected[1].element_index, Some(0));
        assert_eq!(format_app_body(&projected[1]), "MenuButton \"Open\"");
        let body = format_app_body(&projected[2]);
        assert!(body.contains("range=0..16408"));
        assert_eq!(body.matches("Decrement").count(), 1);
        assert_eq!(body.matches("Increment").count(), 1);
    }

    #[test]
    fn rich_text_deduplicates_only_passive_exact_content() {
        let mut editor = node("AXTextArea", "Editor", 1, Some(0));
        editor.value = Some("hello".into());
        editor.rich_text = Some(super::super::app_text::RichText {
            text: "hello".into(),
            markdown: "**hello**".into(),
            source_offsets: Vec::new(),
        });
        let projected = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            editor.clone(),
            node("AXStaticText", "hello", 2, None),
        ]);
        assert_eq!(projected.len(), 2);
        let text = format_app_body(&projected[1]);
        assert!(text.contains("value=\"**hello**\""));
        assert!(text.contains("content_format=markdown"));
        let projected = project_app_nodes(vec![editor, node("AXLink", "hello", 2, Some(1))]);
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[1].element_index, Some(1));
    }

    #[test]
    fn selection_clearing_is_a_change_and_unit_slider_range_is_retained() {
        use cua_driver_core::observation_revision::{
            CapturedNode, ObservationLineage, ObservationMode,
        };
        let mut item = node("AXRow", "Account", 0, Some(0));
        item.selected = Some(true);
        let capture = |item: &AXNode| {
            vec![CapturedNode {
                identity: "row",
                depth: 0,
                body: format_app_body(item),
                actionable_index: Some(0),
            }]
        };
        let mut lineage = ObservationLineage::new("selected", 8).unwrap().for_app();
        let before = lineage.observe(capture(&item), None, false).unwrap();
        item.selected = Some(false);
        let after = lineage
            .observe(capture(&item), Some(&before.revision_id), false)
            .unwrap();
        assert_ne!(after.mode, ObservationMode::NoChange);
        assert_eq!(before.nodes[0].element_id, after.nodes[0].element_id);
        let mut slider = node("AXSlider", "Volume", 0, Some(1));
        slider.min_value = Some(0.0);
        slider.max_value = Some(1.0);
        assert!(format_app_body(&slider).contains("range=0..1"));
    }

    #[test]
    fn disabled_empty_action_leaf_prunes_but_disabled_help_and_focus_remain() {
        let mut empty = node("AXButton", "", 1, None);
        empty.enabled = Some(false);
        empty.actions = vec!["AXPress".into()];
        let mut described = empty.clone();
        described.help = Some("No active document".into());
        let mut focused = empty.clone();
        focused.focused = Some(true);
        let projected = project_app_nodes(vec![
            node("AXWindow", "Document", 0, None),
            empty,
            described,
            focused,
        ]);
        assert_eq!(projected.len(), 3);
        assert!(format_app_body(&projected[1]).contains("No active document"));
        assert!(format_app_body(&projected[2]).contains("disabled focused"));
    }

    #[test]
    fn linked_label_keeps_action_target_and_does_not_repeat_plain_value() {
        let mut link = node("AXLink", "Qwen", 1, Some(17));
        link.url = Some("https://qwen.ai/".into());
        link.value_state = Some("Qwen".into());
        link.actions = vec!["AXPress".into()];
        let projected = project_app_nodes(vec![node("AXWindow", "Browser", 0, None), link]);
        assert_eq!(projected[1].element_index, Some(17));
        let text = format_app_body(&projected[1]);
        assert_eq!(
            text,
            "Link \"[Qwen](<https://qwen.ai/>)\" content_format=markdown"
        );
    }

    #[test]
    fn style_only_change_produces_diff_and_preserves_the_editor_id() {
        use cua_driver_core::observation_revision::{
            CapturedNode, ObservationLineage, ObservationMode,
        };
        let capture = |markdown: &str| {
            let mut editor = node("AXTextArea", "Editor", 0, Some(7));
            editor.rich_text = Some(super::super::app_text::RichText {
                text: "word".into(),
                markdown: markdown.into(),
                source_offsets: Vec::new(),
            });
            vec![CapturedNode {
                identity: "editor",
                depth: 0,
                body: format_app_body(&editor),
                actionable_index: editor.element_index,
            }]
        };
        let mut lineage = ObservationLineage::new("style", 8).unwrap().for_app();
        let before = lineage.observe(capture("word"), None, false).unwrap();
        let after = lineage
            .observe(capture("**word**"), Some(&before.revision_id), false)
            .unwrap();
        assert_ne!(after.mode, ObservationMode::NoChange);
        assert!(after.text.contains("**word**"));
        assert_eq!(before.nodes[0].element_id, after.nodes[0].element_id);
    }

    #[test]
    fn selectable_text_flattens_into_the_target_but_not_table_rows_or_focused_items() {
        let mut item = node("AXRow", "Document", 0, Some(4));
        item.selectable = true;
        let child = node("AXStaticText", "Edited today", 1, None);
        let projected = project_app_nodes(vec![item.clone(), child.clone()]);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].element_index, Some(4));
        assert_eq!(projected[0].value.as_deref(), Some("Edited today"));
        for guard in 0..3 {
            let mut guarded = item.clone();
            match guard {
                0 => guarded.focused = Some(true),
                1 => guarded.table_row = true,
                _ => guarded.role = "AXTable".into(),
            }
            assert_eq!(project_app_nodes(vec![guarded, child.clone()]).len(), 2);
        }
        let projected = project_app_nodes(vec![item, child, node("AXButton", "Open", 1, Some(5))]);
        assert_eq!(projected.len(), 3);
        assert_eq!(projected[2].element_index, Some(5));
    }

    #[test]
    fn associated_title_deduplicates_only_the_explicit_native_identity() {
        use super::super::bindings::{AXUIElementCreateApplication, AXUIElementRef};
        use super::super::tree::AXIdentity;
        use core_foundation::base::{CFRelease, CFTypeRef};
        unsafe {
            let pointer: AXUIElementRef = AXUIElementCreateApplication(std::process::id() as i32);
            let identity = AXIdentity::retained(pointer);
            CFRelease(pointer as CFTypeRef);
            let mut related = node("AXStaticText", "Account", 1, None);
            related.identity = Some(identity.clone());
            let unrelated = node("AXStaticText", "Account", 1, None);
            let mut field = node("AXTextField", "Account", 1, Some(0));
            field.title_ui_element = Some(identity);
            let projected = project_app_nodes(vec![
                node("AXWindow", "Form", 0, None),
                related,
                field,
                unrelated,
            ]);
            assert_eq!(projected.len(), 3);
            assert_eq!(projected[1].element_index, Some(0));
            assert_eq!(projected[2].role, "AXStaticText");
        }
    }
}

#[cfg(test)]
mod approved_regressions {
    use super::super::tree::AXNode;
    use super::{format_app_body, project_app_nodes};
    fn node(role: &str, title: &str, depth: usize, index: Option<usize>) -> AXNode {
        AXNode {
            role: role.into(),
            title: (!title.is_empty()).then(|| title.into()),
            depth,
            element_index: index,
            ..Default::default()
        }
    }
    #[test]
    fn duplicate_secondary_actions_are_rendered_once_without_mutating_native_names() {
        let mut scrollbar = node("AXScrollBar", "Vertical scroll bar", 0, Some(7));
        scrollbar.actions = vec![
            "AXDecrement".into(),
            "AXIncrement".into(),
            "AXDecrement".into(),
            "AXIncrement".into(),
        ];
        let rendered = format_app_body(&scrollbar);
        assert_eq!(rendered.matches("Decrement").count(), 1, "{rendered}");
        assert_eq!(rendered.matches("Increment").count(), 1, "{rendered}");
        assert_eq!(scrollbar.element_index, Some(7));
        assert_eq!(scrollbar.actions.len(), 4);
    }
    #[test]
    fn default_selection_and_binary_button_range_do_not_bloat_output() {
        let mut button = node("AXButton", "Save", 0, Some(5));
        button.selected = Some(false);
        button.min_value = Some(0.0);
        button.max_value = Some(1.0);
        button.value_state = Some("0".into());
        let rendered = format_app_body(&button);
        assert!(!rendered.contains("selected=false"), "{rendered}");
        assert!(!rendered.contains("range="), "{rendered}");
        assert!(rendered.contains("value=\"0\""), "{rendered}");
    }
    #[test]
    fn text_state_changes_are_not_erased_by_parent_label_deduplication() {
        let capture = |value: &str| {
            let mut status = node("AXStaticText", "Progress", 1, None);
            status.value_state = Some(value.into());
            project_app_nodes(vec![node("AXWindow", "Progress", 0, None), status])
                .iter()
                .map(format_app_body)
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_ne!(
            capture("41"),
            capture("42"),
            "Distinct captured state must reach revision rendering"
        );
    }
    #[test]
    fn range_on_static_text_survives_sibling_consolidation() {
        let mut range = node("AXStaticText", "Scale", 1, None);
        range.min_value = Some(0.0);
        range.max_value = Some(100.0);
        let projected = project_app_nodes(vec![
            node("AXWindow", "Doc", 0, None),
            node("AXStaticText", "Intro", 1, None),
            range,
        ]);
        assert!(projected
            .iter()
            .any(|n| format_app_body(n).contains("range=0..100")));
    }
    #[test]
    fn selectable_item_consolidates_passive_text_without_remapping_its_target() {
        // This fixture models an AXSelected-settable item; ba1a833 stores only the
        // combined focusable_or_selectable flag. The final in-module fixture must
        // set the separate captured selectability flag when it is introduced.
        let mut item = node("AXGroup", "Inbox", 1, Some(7));
        item.focusable_or_selectable = true;
        item.selectable = true;
        item.selected = Some(false);
        let projected = project_app_nodes(vec![
            node("AXWindow", "Mail", 0, None),
            item,
            node("AXStaticText", "2 unread", 2, None),
        ]);
        assert_eq!(
            projected
                .iter()
                .filter_map(|n| n.element_index)
                .collect::<Vec<_>>(),
            vec![7]
        );
        let owner = projected
            .iter()
            .find(|n| n.element_index == Some(7))
            .unwrap();
        assert!(
            format_app_body(owner).contains("2 unread"),
            "Consolidated text belongs to the selected target"
        );
        assert_eq!(projected.len(), 2);
    }
    #[test]
    fn addressable_descendants_and_web_trust_are_preserved() {
        let mut web = node("AXStaticText", "web", 1, Some(8));
        web.in_web_content = true;
        let projected = project_app_nodes(vec![
            node("AXWindow", "Doc", 0, None),
            node("AXGroup", "", 1, None),
            node("AXButton", "Save", 2, Some(7)),
            web,
        ]);
        assert_eq!(
            projected
                .iter()
                .filter_map(|n| n.element_index)
                .collect::<Vec<_>>(),
            vec![7, 8]
        );
        assert!(projected.last().unwrap().in_web_content);
    }
    #[test]
    fn disabled_named_controls_and_numeric_slider_state_remain_visible() {
        let mut disabled = node("AXMenuItem", "Paste", 1, None);
        disabled.enabled = Some(false);
        let mut slider = node("AXSlider", "Volume", 1, Some(4));
        slider.value_state = Some("0.5".into());
        slider.min_value = Some(0.0);
        slider.max_value = Some(1.0);
        let projected = project_app_nodes(vec![node("AXMenu", "Edit", 0, None), disabled, slider]);
        assert!(format_app_body(&projected[1]).contains("disabled"));
        let rendered = format_app_body(&projected[2]);
        assert!(rendered.contains("value=\"0.5\""));
        assert!(rendered.contains("range=0..1"));
    }
}
