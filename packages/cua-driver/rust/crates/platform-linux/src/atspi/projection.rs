use super::AtspiNode;

fn label(node: &AtspiNode) -> &str {
    node.name
        .as_deref()
        .or(node.value.as_deref())
        .or(node.description.as_deref())
        .unwrap_or_default()
}

fn protected(node: &AtspiNode) -> bool {
    node.element_index.is_some()
        || node.focused == Some(true)
        || node.selected == Some(true)
        || node.checked == Some(true)
        || !node.actions.is_empty()
}

fn label_only(node: &AtspiNode) -> bool {
    node.enabled != Some(false)
        && [
            node.name.as_deref(),
            node.value.as_deref(),
            node.description.as_deref(),
        ]
        .into_iter()
        .flatten()
        .all(|value| value == label(node))
}

fn text_only(node: &AtspiNode, leaf: bool) -> bool {
    leaf && !protected(node)
        && label_only(node)
        && matches!(node.role.as_str(), "label" | "static" | "static text")
}

fn context(node: &AtspiNode) -> bool {
    matches!(
        node.role.as_str(),
        "frame"
            | "window"
            | "dialog"
            | "alert"
            | "menu"
            | "menu bar"
            | "table"
            | "table row"
            | "table cell"
            | "list"
            | "list item"
            | "tree"
            | "tree item"
            | "page tab list"
    ) || node.role.contains("document")
}

/// Project presentation only: native actionable indices and identities never change.
pub(crate) fn compact(nodes: Vec<AtspiNode>) -> Vec<AtspiNode> {
    let mut ends = vec![nodes.len(); nodes.len()];
    let mut ancestry: Vec<usize> = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        while ancestry
            .last()
            .is_some_and(|&parent| nodes[parent].depth >= node.depth)
        {
            ends[ancestry.pop().expect("checked ancestor")] = index;
        }
        ancestry.push(index);
    }
    let mut skip = vec![false; nodes.len()];
    for (index, node) in nodes.iter().enumerate() {
        if protected(node) || context(node) || !label_only(node) {
            continue;
        }
        let leaf = ends[index] == index + 1;
        let layout = matches!(
            node.role.as_str(),
            "filler" | "panel" | "section" | "scroll pane" | "unknown"
        );
        skip[index] = (label(node).is_empty() && (layout || leaf))
            || (layout
                && !leaf
                && ends[index + 1] == ends[index]
                && nodes[index + 1].in_web_content == node.in_web_content
                && label(&nodes[index + 1]) == label(node));
    }

    let mut result: Vec<AtspiNode> = Vec::new();
    let mut parents: Vec<(usize, usize)> = Vec::new();
    let mut previous_text_parent = None;
    let mut previous_was_text = false;
    for (index, mut node) in nodes.into_iter().enumerate() {
        while parents
            .last()
            .is_some_and(|(depth, _)| *depth >= node.depth)
        {
            parents.pop();
        }
        if skip[index] {
            continue;
        }
        let source_depth = node.depth;
        let parent = parents.last().map(|&(_, index)| index);
        let text = text_only(&node, ends[index] == index + 1);
        if text
            && parent.is_some_and(|parent| {
                let parent = &result[parent];
                parent.in_web_content == node.in_web_content
                    && !label(parent).is_empty()
                    && label(parent) == label(&node)
            })
        {
            continue;
        }
        if text && previous_was_text && previous_text_parent == parent {
            if let Some(previous) = result
                .last_mut()
                .filter(|previous| previous.in_web_content == node.in_web_content)
            {
                let combined = format!("{}\n{}", label(previous), label(&node));
                previous.name = Some(combined);
                previous.value = None;
                previous.description = None;
                continue;
            }
        }
        node.depth = parents.len();
        node.parent_element_index = parent.and_then(|parent| {
            result[parent]
                .element_index
                .or(result[parent].parent_element_index)
        });
        previous_was_text = text;
        previous_text_parent = parent;
        parents.push((source_depth, result.len()));
        result.push(node);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atspi::AtspiIdentity;

    fn node(role: &str, text: &str, depth: usize, index: Option<usize>) -> AtspiNode {
        AtspiNode {
            role: role.into(),
            name: Some(text.into()),
            depth,
            element_index: index,
            identity: Some(AtspiIdentity {
                unique_owner: ":1.2".into(),
                object_path: format!("/{role}/{depth}/{index:?}"),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn folds_layout_and_duplicate_labels_without_changing_controls() {
        let button = node("push button", "Save", 3, Some(7));
        let projected = compact(vec![
            node("frame", "Document", 0, None),
            node("panel", "", 1, None),
            node("panel", "Save", 2, None),
            button.clone(),
            node("label", "Save", 4, None),
        ]);
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[1].element_index, Some(7));
        assert_eq!(projected[1].identity, button.identity);
        assert_eq!(projected[1].depth, 1);
    }

    #[test]
    fn merges_static_siblings_but_keeps_table_and_web_boundaries() {
        let mut web = node("label", "web", 1, None);
        web.in_web_content = true;
        let projected = compact(vec![
            node("frame", "Document", 0, None),
            node("label", "first", 1, None),
            node("static", "second", 1, None),
            web,
            node("table row", "", 1, None),
            node("label", "row one", 2, None),
            node("table row", "", 1, None),
            node("label", "row two", 2, None),
        ]);
        assert_eq!(projected.len(), 7);
        assert_eq!(label(&projected[1]), "first\nsecond");
        assert_eq!(label(&projected[2]), "web");
        assert_eq!(label(&projected[4]), "row one");
        assert_eq!(label(&projected[6]), "row two");
    }

    #[test]
    fn preserves_empty_values_states_actions_and_action_ancestry() {
        let mut field = node("entry", "Name", 0, Some(4));
        field.value = Some(String::new());
        let mut focused = node("panel", "", 1, None);
        focused.focused = Some(true);
        let mut disabled = node("push button", "", 1, None);
        disabled.enabled = Some(false);
        disabled.actions = vec!["click".into()];
        let mut selected = node("list item", "", 1, None);
        selected.selected = Some(true);
        let projected = compact(vec![
            field,
            focused,
            disabled,
            selected,
            node("entry", "Child", 1, Some(9)),
        ]);
        assert_eq!(projected.len(), 5);
        assert_eq!(projected[0].value.as_deref(), Some(""));
        assert_eq!(projected[1].focused, Some(true));
        assert_eq!(projected[2].actions, ["click"]);
        assert_eq!(projected[3].selected, Some(true));
        assert_eq!(projected[4].parent_element_index, Some(4));
    }

    #[test]
    fn deep_empty_layout_is_iterative() {
        let mut nodes = (0..5000)
            .map(|depth| node("panel", "", depth, None))
            .collect::<Vec<_>>();
        nodes.push(node("entry", "End", 5000, Some(0)));
        let projected = compact(nodes);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].depth, 0);
        assert_eq!(projected[0].element_index, Some(0));
    }

    #[test]
    fn redundant_form_shrinks_without_losing_field_values_or_tokens() {
        let mut nodes = vec![node("frame", "Profile", 0, None)];
        for index in 0..8 {
            nodes.push(node("panel", "", 1, None));
            let label = format!("Field {index}");
            let mut field = node("entry", &label, 2, Some(index));
            field.value = Some(format!("value {index}"));
            nodes.push(field);
            nodes.push(node("label", &label, 3, None));
        }
        let render = |nodes: &[AtspiNode]| {
            nodes
                .iter()
                .map(super::super::format_revision_body)
                .collect::<Vec<_>>()
                .join("\n")
        };
        let full = render(&nodes);
        let projected = compact(nodes.clone());
        let compact_text = render(&projected);
        assert!(compact_text.len() < full.len());
        assert_eq!(projected.len(), 9);
        for original in nodes.iter().filter(|node| node.element_index.is_some()) {
            let retained = projected
                .iter()
                .find(|node| node.element_index == original.element_index)
                .unwrap();
            assert_eq!(retained.identity, original.identity);
            assert_eq!(retained.value, original.value);
            assert_eq!(retained.actions, original.actions);
        }
    }
}
