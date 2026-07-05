# Status Configuration

Session statuses represent workflow states. Each workspace has its own status configuration.

## Storage Locations

- Config: `~/.craft-agent/workspaces/{id}/statuses/config.json`
- Icons: `~/.craft-agent/workspaces/{id}/statuses/icons/`

## Default Statuses

| ID | Label | Default Color | Category | Type |
|----|-------|---------------|----------|------|
| `backlog` | Backlog | foreground/50 | open | Default |
| `todo` | Todo | foreground/50 | open | Fixed |
| `needs-review` | Needs Review | info | open | Default |
| `done` | Done | accent | closed | Fixed |
| `cancelled` | Cancelled | foreground/50 | closed | Fixed |

**Note:** Color is optional. When omitted, the design system default is used.

## Color Format

Colors use the `EntityColor` type — either a system color string or a custom color object.

### System Colors

Auto-adapt to light/dark theme via CSS variables. No hex values needed.

| Name | Appearance | Example |
|------|-----------|---------|
| `"accent"` | Purple (brand) | `"accent"` |
| `"info"` | Amber | `"info"` |
| `"success"` | Green | `"success"` |
| `"destructive"` | Red | `"destructive"` |
| `"foreground"` | Text color | `"foreground"` |

Add `/opacity` (integer 0–100) for transparency: `"foreground/50"`, `"info/80"`.

### Custom Colors

Object with explicit CSS color values for light and dark themes:

```json
{ "light": "#EF4444", "dark": "#F87171" }
```

If `dark` is omitted, it's auto-derived from `light` (brightened ~30%).

**Supported CSS color formats for `light`/`dark` values:**

| Format | Example |
|--------|---------|
| Hex (3-digit) | `"#F00"` |
| Hex (6-digit) | `"#EF4444"` |
| Hex (8-digit, with alpha) | `"#EF444480"` |
| OKLCH | `"oklch(0.7 0.15 20)"` |
| RGB | `"rgb(239, 68, 68)"` |
| HSL | `"hsl(0, 84%, 60%)"` |

### Common Mistakes

- Bare color names (`"red"`, `"blue"`) are **not** supported — use hex or system colors
- Tailwind classes (`"text-red-500"`) are **not** valid — use system color names directly
- Hex without `#` prefix (`"EF4444"`) is invalid — always include `#`
- System color opacity must be an integer 0–100 (`"foreground/50"` not `"foreground/0.5"`)

## Status Types

- **Fixed** (`isFixed: true`): Cannot be deleted or renamed. Required statuses: `todo`, `done`, `cancelled`.
- **Default** (`isDefault: true`): Ships with app, can be modified but not deleted.
- **Custom** (`isFixed: false, isDefault: false`): User-created, fully editable and deletable.

## Category System

- **open**: Session appears in inbox/active list
- **closed**: Session appears in archive/completed list

## config.json Schema

```json
{
  "version": 1,
  "statuses": [
    {
      "id": "todo",
      "label": "Todo",
      "category": "open",
      "isFixed": true,
      "isDefault": false,
      "order": 0
    }
  ],
  "defaultStatusId": "todo"
}
```

**Note:** The `icon` field is optional. Default statuses use auto-discovered SVG files from `statuses/icons/{id}.svg`.

## Status Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique slug (lowercase, hyphens) |
| `label` | string | Display name |
| `color` | string? | Optional color (hex or Tailwind class). Uses design system default if omitted. |
| `icon` | string? | Optional emoji (e.g., `"🔥"`) or URL. Omit to use auto-discovered file. |
| `category` | `"open"` \| `"closed"` | Inbox vs archive |
| `isFixed` | boolean | Cannot delete/rename if true |
| `isDefault` | boolean | Ships with app, cannot delete |
| `order` | number | Display order (lower = first) |

## Icon Configuration

Icon resolution priority:
1. **Local file** - Auto-discovered from `statuses/icons/{id}.svg` (or .png, .jpg, .jpeg)
2. **Emoji** - If `icon` field is an emoji string (e.g., `"🔥"`)
3. **Fallback** - Bullet character if no icon found

**File-based icons (recommended for default statuses):**
- Place SVG in `statuses/icons/{status-id}.svg`
- No config needed - auto-discovered by status ID
- Example: `statuses/icons/blocked.svg` for status ID `blocked`

**Emoji icons (quick and easy):**
```json
"icon": "🔥"
```

**URL icons (auto-downloaded):**
```json
"icon": "https://example.com/icon.svg"
```
URLs are automatically downloaded to `statuses/icons/{id}.{ext}`.

**⚠️ Icon Sourcing Rules:**
- **DO** generate custom SVG files following the guidelines below
- **DO** download icons from the web (e.g., Heroicons, Feather, Simple Icons)
- **DO** use emoji for quick, universal icons

## Adding Custom Statuses

Edit the workspace's `statuses/config.json`:

```json
{
  "id": "blocked",
  "label": "Blocked",
  "color": "destructive",
  "icon": "🚫",
  "category": "open",
  "isFixed": false,
  "isDefault": false,
  "order": 3
}
```

Or with a custom hex color:
```json
{
  "id": "blocked",
  "label": "Blocked",
  "color": { "light": "#EF4444", "dark": "#F87171" },
  "icon": "🚫",
  "category": "open",
  "isFixed": false,
  "isDefault": false,
  "order": 3
}
```

Adjust `order` values for existing statuses as needed.

## SVG Icon Guidelines

- Size: 24x24
- Use `currentColor` for stroke/fill (theming support)
- stroke-width: 2
- stroke-linecap: round
- stroke-linejoin: round

## Self-Healing

- Missing icon files are auto-recreated from embedded defaults
- Invalid status IDs on sessions fallback to `todo`
- Corrupted configs reset to defaults

## Validation

**IMPORTANT**: Always validate after creating or editing statuses:

```
config_validate({ target: "statuses" })
```

This validates:
- Required fixed statuses exist (`todo`, `done`, `cancelled`)
- No duplicate status IDs
- `defaultStatusId` references an existing status
- Icon files exist when referenced
- At least one status in each category (open/closed)

Invalid configs will fall back to defaults at runtime, but validation catches issues before they cause problems.
