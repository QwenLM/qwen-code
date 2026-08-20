# Label Configuration

Labels are additive tags that can be applied to sessions. Unlike statuses (which are exclusive — one per session), labels are multi-select (many per session). They support hierarchical organization via nested JSON trees.

> **CLI-first workflow (recommended):** Use `craft-agent label ...` commands instead of editing JSON directly.
> - `craft-agent label --help`
> - Canonical command reference: [craft-cli.md](./craft-cli.md)

## Storage Locations

- Config: `~/.craft-agent/workspaces/{id}/labels/config.json`

## No Defaults (Regular Labels)

Unlike statuses, regular labels start empty. Users create whatever labels they need. There are no built-in or required regular labels.

## Visual Representation

Labels are color-only — rendered as colored circles in the UI. No icons or emoji are supported.

## Hierarchical Labels (Nested Tree)

Labels form a nested JSON tree. Hierarchy is the structure itself — parent/child relationships are expressed via the `children` array. Array position determines display order (no `order` field needed).

**Example:**
```json
{
  "version": 1,
  "labels": [
    {
      "id": "eng",
      "name": "Engineering",
      "color": "info",
      "children": [
        {
          "id": "frontend",
          "name": "Frontend",
          "children": [
            { "id": "react", "name": "React", "color": { "light": "#3B82F6", "dark": "#60A5FA" } }
          ]
        },
        { "id": "backend", "name": "Backend" }
      ]
    },
    { "id": "bug", "name": "Bug", "color": "destructive" }
  ]
}
```

This renders as a tree in the sidebar:
```
Engineering
  ├─ Frontend
  │    └─ React
  └─ Backend
Bug
```

**Rules:**
- IDs are simple slugs (lowercase alphanumeric + hyphens)
- IDs must be globally unique across the entire tree
- Maximum nesting depth: 5 levels
- Array position = display order (no `order` field)
- Filtering by a parent includes all descendants

## config.json Schema

```json
{
  "version": 1,
  "labels": [
    {
      "id": "bug",
      "name": "Bug",
      "color": "destructive"
    },
    {
      "id": "feature",
      "name": "Feature",
      "color": "accent",
      "children": [
        { "id": "ui", "name": "UI", "color": { "light": "#6366F1", "dark": "#818CF8" } },
        { "id": "api", "name": "API", "color": { "light": "#10B981", "dark": "#34D399" } }
      ]
    }
  ]
}
```

## Label Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique slug, globally unique across tree (e.g., `"bug"`, `"frontend"`). Lowercase alphanumeric + hyphens. |
| `name` | string | Display name |
| `color` | EntityColor? | Optional color. System color string (e.g., `"accent"`, `"info/80"`) or custom object (`{ "light": "#hex", "dark": "#hex" }`). Rendered as a colored circle in the UI. |
| `valueType` | `'string' \| 'number' \| 'date'`? | Optional value type hint. Tells UI what input widget to show and agents what format to write. Omit for boolean (presence-only) labels. |
| `children` | LabelConfig[]? | Optional nested child labels. Array position = display order. |

## Color Format

Same as statuses — see [statuses documentation](./statuses.md#color-format) for full details on supported formats and common mistakes.

**System colors:** `"accent"`, `"info"`, `"success"`, `"destructive"`, `"foreground"` (with optional `/opacity` 0–100)

**Custom colors:** `{ "light": "#EF4444", "dark": "#F87171" }` — supports hex, OKLCH, RGB, HSL formats

## Session Labels

Sessions store labels as an array of strings. Boolean labels are bare IDs; valued labels use the `::` separator:

```json
{
  "labels": ["bug", "priority::3", "due::2026-01-30", "linear::https://linear.app/issue/ENG-456"]
}
```

- Labels are additive (a session can have zero or many labels)
- Boolean labels: `"bug"` — presence-only, no value
- Valued labels: `"priority::3"` — ID + value separated by `::`
- The `::` split happens on the first occurrence only (values may contain `::`)
- Invalid label IDs are silently filtered out at read time
- Deleting a label strips it from all sessions automatically (children are also removed)
- Hierarchical filtering: clicking a parent label shows sessions tagged with it or any descendant

### Value Types

Values are inferred from the raw string at parse time:

| Type | Format | Example |
|------|--------|---------|
| `number` | Finite number | `"priority::3"`, `"effort::0.5"` |
| `date` | ISO date (YYYY-MM-DD) | `"due::2026-01-30"` |
| `string` | Anything else | `"link::https://example.com"` |

**Inference order:** ISO date check → number check → string fallback.

The optional `valueType` in config is a hint only — the parser always infers from the raw value regardless.

## Adding Labels

Prefer `craft-agent` commands:

```bash
craft-agent label create --name "Bug" --color "destructive"
craft-agent label create --name "Priority" --color "accent" --value-type number
craft-agent label create --name "Due Date" --color "info" --value-type date
craft-agent label create --name "Project" --color "foreground/60"
craft-agent label create --name "Alpha" --color "info" --parent-id project
craft-agent label create --name "Beta" --color "success" --parent-id project
```

Use direct JSON edits only for bulk/manual operations where CLI is not sufficient.

## Color Conventions

When creating or modifying labels, follow these conventions unless the user explicitly requests otherwise:

1. **Always add colors.** Every label should have a `color` for visual identification (rendered as a colored circle).

2. **Use complementary colors within a category.** Sibling labels (children of the same parent) should use colors from the same family or hue range, creating a cohesive visual group. For example, a "Backend" group might use greens/teals for its children (API, Database), while "Frontend" uses indigos/blues (React, CSS).

3. **Use semantic colors for semantic meanings:**
   - Bugs/errors → `"destructive"` or red tones
   - Features/enhancements → `"accent"` or blue/indigo tones
   - Success/done → `"success"` or green tones
   - Info/metadata → `"info"` or sky/cyan tones
   - Neutral/misc → `"foreground/60"` or gray tones

**Color format reminder:** Use custom `{ "light": "#hex", "dark": "#hex" }` objects for sub-labels to get precise color control. Reserve system colors (`"accent"`, `"info"`, `"destructive"`, etc.) for top-level parent categories.

## Validation

**IMPORTANT**: Always validate after creating or editing labels:

```
config_validate({ target: "labels" })
```

This validates:
- Valid JSON and recursive schema structure
- Globally unique IDs across the entire tree
- Valid slug format (lowercase alphanumeric with hyphens)
- Maximum nesting depth (5 levels)

## Auto-Label Rules

Auto-label rules automatically scan user messages and apply labels with extracted values. Configure regex patterns on any label to trigger automatic tagging.

### Configuration

Add `autoRules` to any label in `config.json`:

```json
{
  "id": "linear-issue",
  "name": "Linear Issue",
  "color": "purple",
  "valueType": "string",
  "autoRules": [
    {
      "pattern": "linear\\.app/[\\w-]+/issue/([A-Z]+-\\d+)",
      "valueTemplate": "$1",
      "description": "Matches Linear issue URLs"
    },
    {
      "pattern": "\\b([A-Z]{2,5}-\\d+)\\b",
      "valueTemplate": "$1",
      "description": "Matches bare issue keys like CRA-123"
    }
  ]
}
```

### AutoLabelRule Properties

| Property | Type | Description |
|----------|------|-------------|
| `pattern` | string | **Required.** Regex with capture groups. Uses `flags` (default: `gi`). |
| `flags` | string | Regex flags (default: `gi` — global, case-insensitive). `g` is always enforced. |
| `valueTemplate` | string | Template using `$1`, `$2` for capture group substitution. If omitted, uses first capture group. |
| `description` | string | Human-readable description of what this rule matches. |

### Regex Patterns

Rules use JavaScript regular expressions with capture groups:

```json
{
  "pattern": "github\\.com/([\\w-]+/[\\w-]+)/pull/(\\d+)",
  "valueTemplate": "$1#$2",
  "description": "Matches GitHub PR URLs"
}
```

- **Global matching**: The `g` flag is always enforced, so all occurrences in a message are found
- **Capture groups**: `$1`, `$2`, etc. are replaced with matched groups in `valueTemplate`
- **Multiple matches**: "CRA-1 and CRA-2" produces two label entries on the same label
- **Code block stripping**: Content inside fenced code blocks and inline code is ignored

### Value Normalization

Extracted values are normalized based on the label's `valueType`:

| valueType | Raw capture | Normalized |
|-----------|-------------|------------|
| `string` | `CRA-123` | `CRA-123` (pass-through) |
| `number` | `$45,000` | `45000` (strip symbol + commas) |
| `number` | `1.5M` | `1500000` (expand suffix) |
| `number` | `50k` | `50000` (expand suffix) |
| `date` | `2026-01-30` | `2026-01-30` (pass-through) |

### Evaluation Behavior

- **Timing**: Rules are evaluated when a user message is sent (both fresh and queued messages)
- **User messages only**: Assistant output and tool results are not scanned
- **Code stripping**: Fenced code blocks and inline code are stripped before evaluation
- **Deduplication**: Same label+value won't be added twice to a session
- **Match limit**: Maximum 10 matches per message (prevents label explosion from pasted data)
- **Persistence**: Auto-applied labels are stored on the session
- **Multiple rules**: All rules on a label are evaluated; all matches are collected
- **Validation**: Patterns are validated at config-save time (invalid regex and ReDoS patterns are rejected)
- **Error handling**: Invalid regex patterns are skipped at runtime (logged as warnings)

### Full Example

A workspace that auto-tags Linear issues, deadlines, contacts, and budgets:

```json
{
  "version": 1,
  "labels": [
    {
      "id": "linear-issue",
      "name": "Linear Issue",
      "color": "purple",
      "valueType": "string",
      "autoRules": [
        { "pattern": "linear\\.app/[\\w-]+/issue/([A-Z]+-\\d+)", "valueTemplate": "$1", "description": "Linear URLs" },
        { "pattern": "\\b([A-Z]{2,5}-\\d+)\\b", "valueTemplate": "$1", "description": "Bare issue keys" }
      ]
    },
    {
      "id": "deadline",
      "name": "Deadline",
      "color": "orange",
      "valueType": "date",
      "autoRules": [
        { "pattern": "(\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?)", "valueTemplate": "$1", "description": "ISO dates" }
      ]
    },
    {
      "id": "contact",
      "name": "Contact",
      "color": "blue",
      "valueType": "string",
      "autoRules": [
        { "pattern": "([\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,})", "valueTemplate": "$1", "description": "Email addresses" }
      ]
    },
    {
      "id": "budget",
      "name": "Budget",
      "color": "green",
      "valueType": "number",
      "autoRules": [
        { "pattern": "\\$([\\d,.]+[kKmMbB]?)", "valueTemplate": "$1", "description": "Dollar amounts" }
      ]
    }
  ]
}
```

## Sidebar Behavior

Labels appear in the left sidebar as a multi-level expandable section:

```
All Sessions (flat, total count)
Flagged      (flat, flagged count)
States       (expandable → status sub-items)
Labels       (expandable)
  ├─ Views       (expandable → view sub-items)
  ├─ Engineering (label)
  └─ Bug         (label)
────────────
Sources      (expandable → API/MCP/Local)
Skills       (flat)
────────────
Settings     (flat)
```

Clicking a label filters the session list. Clicking a parent label includes sessions tagged with any descendant.

## Design Decisions

- **Nested JSON tree**: Hierarchy is the structure itself — no conventions to learn
- **Array position = order**: No `order` field needed, array position determines display order
- **Globally unique IDs**: Simple slugs, unique across the entire tree
- **Color-only visual**: Labels use colored circles — no icons, keeping the UI clean and consistent
- **No categories**: Labels don't affect inbox/archive filtering (that's what statuses are for)
- **No defaults**: Workspaces start with zero labels
- **No fixed labels**: All labels are fully user-controlled (deletable, renameable)
- **Multi-select**: Sessions store `labels: string[]`, not a single value
- **Delete cascade**: Deleting a label removes it and all descendants from sessions
- **Max depth 5**: Prevents excessively deep hierarchies
- **Hierarchical filtering**: Parent label clicks include all descendant sessions
- **Values via `::` separator**: Simple, flat string storage — no schema changes to session format
- **Type inference at parse time**: Parser always infers (date → number → string), `valueType` is just a UI hint
- **Date-only format**: ISO `YYYY-MM-DD` — no time component, avoids timezone complexity
