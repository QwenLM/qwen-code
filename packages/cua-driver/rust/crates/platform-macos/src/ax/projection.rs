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
        || node.focused == Some(true)
        || node.selected == Some(true)
        || !node.actions.is_empty()
}

fn text_only(branch: &Branch) -> bool {
    branch.node.role == "AXStaticText"
        && branch.children.is_empty()
        && !protected(&branch.node)
        && branch.node.enabled != Some(false)
        && branch.node.help.is_none()
        && branch.node.identifier.is_none()
        && branch.node.value_description.is_none()
        && branch.node.selected.is_none()
        && [
            branch.node.title.as_deref(),
            branch.node.description.as_deref(),
            branch.node.value.as_deref(),
        ]
        .into_iter()
        .flatten()
        .all(|value| value == label(&branch.node))
}

fn project(branch: Branch) -> Vec<Branch> {
    let Branch { mut node, children } = branch;
    let children = children.into_iter().flat_map(project).collect::<Vec<_>>();
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
    let descriptive = !label(&node).is_empty()
        || node
            .value_state
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || node.help.is_some()
        || node.value_description.is_some();
    let layout = matches!(
        node.role.as_str(),
        "AXGroup" | "AXScrollArea" | "AXLayoutArea" | "AXUnknown"
    );
    if !protected(&node) && !descriptive && layout && node.enabled != Some(false) {
        return merged;
    }
    if !protected(&node) && !descriptive && node.enabled == Some(false) && merged.is_empty() {
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
    let label = label(node);
    let quote = |value: &str| serde_json::to_string(value).expect("string serializes");
    let mut fields = vec![
        node.role
            .strip_prefix("AX")
            .unwrap_or(&node.role)
            .to_owned(),
        quote(label),
    ];
    if let Some(value) = node
        .value_state
        .as_deref()
        .or(node.value.as_deref())
        .filter(|value| !value.is_empty() && *value != label)
    {
        fields.push(format!("value={}", quote(value)));
    }
    for (key, value) in [
        ("description", node.description.as_deref()),
        ("help", node.help.as_deref()),
        ("value_description", node.value_description.as_deref()),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty() && *value != label) {
            fields.push(format!("{key}={}", quote(value)));
        }
    }
    if node.enabled == Some(false) {
        fields.push("disabled".to_owned());
    }
    if node.focused == Some(true) {
        fields.push("focused".to_owned());
    }
    if let Some(selected) = node.selected {
        fields.push(format!("selected={selected}"));
    }
    if let (Some(min), Some(max)) = (node.min_value, node.max_value) {
        if min.is_finite() && max.is_finite() && max > min {
            fields.push(format!("range={min}..{max}"));
        }
    }
    let secondary = node
        .actions
        .iter()
        .filter(|action| !matches!(action.as_str(), "AXPress" | "AXPick"))
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
        assert!(text.contains("value=\"0\" disabled selected=false"));
        assert!(text.contains("ShowMenu"));
        assert!(!text.contains("frame=1,2,3,4"));
        assert!(!text.contains("AXPress"));
    }
}
