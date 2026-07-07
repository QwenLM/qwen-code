# Data Tables Guide

This guide covers how to present structured data using datatable and spreadsheet blocks, and how to use the `transform_data` tool for large datasets.

## Overview

Qwen Code supports three ways to display tabular data:

| Format | Best For | Interactivity |
|--------|----------|---------------|
| **Markdown table** | Small, simple data (3-4 rows) | None |
| **`datatable` block** | Query results, comparisons, any data users may sort/filter | Sort, filter, group-by, search |
| **`spreadsheet` block** | Financial reports, exports, data users may download as .xlsx | Sort, export to Excel/CSV |

**Key principle:** For datasets with 20+ rows, use the `transform_data` tool to write data to a JSON file and reference it via `"src"` instead of inlining all rows. This dramatically reduces token usage and cost.

## Inline Tables (Small Datasets)

For datasets under 20 rows, inline the data directly in the markdown block:

### Datatable

````
```datatable
{
  "title": "Top Users",
  "columns": [
    { "key": "name", "label": "Name", "type": "text" },
    { "key": "revenue", "label": "Revenue", "type": "currency" },
    { "key": "growth", "label": "Growth", "type": "percent" },
    { "key": "active", "label": "Active", "type": "boolean" },
    { "key": "tier", "label": "Tier", "type": "badge" }
  ],
  "rows": [
    { "name": "Acme Corp", "revenue": 4200000, "growth": 0.152, "active": true, "tier": "Enterprise" },
    { "name": "StartupCo", "revenue": 85000, "growth": -0.03, "active": true, "tier": "Starter" }
  ]
}
```
````

### Spreadsheet

````
```spreadsheet
{
  "filename": "q4-revenue.xlsx",
  "sheetName": "Revenue",
  "columns": [
    { "key": "month", "label": "Month", "type": "text" },
    { "key": "revenue", "label": "Revenue", "type": "currency" }
  ],
  "rows": [
    { "month": "October", "revenue": 125000 },
    { "month": "November", "revenue": 142000 }
  ]
}
```
````

## Column Types Reference

| Type | Input Format | Rendered As | Example Input | Example Output |
|------|-------------|-------------|---------------|----------------|
| `text` | Any string | Plain text | `"John Doe"` | John Doe |
| `number` | Number | Formatted number | `1500000` | 1,500,000 |
| `currency` | Raw number (not formatted) | Dollar amount | `4200000` | $4,200,000 |
| `percent` | Decimal (0-1 range) | Percentage with color | `0.152` | +15.2% (green) |
| `boolean` | `true`/`false` | Yes/No | `true` | Yes |
| `date` | Date string | Formatted date | `"2025-01-15"` | Jan 15, 2025 |
| `badge` | String | Colored status pill | `"Active"` | Active (badge) |

**Important notes:**
- `currency` — Pass the raw number, NOT a formatted string. `4200000` renders as `$4,200,000`.
- `percent` — Pass as decimal. `0.152` renders as `+15.2%`. Positive values are green, negative are red.
- `boolean` — Use actual `true`/`false`, not strings.

## File-Backed Tables (Large Datasets)

### When to Use

Use the `transform_data` tool + `"src"` field when:
- Dataset has **20+ rows** — inlining costs ~$1+ in tokens for 100 rows
- Data comes from a **large API response** or tool result
- You need to **filter, reshape, or aggregate** raw data before display
- Data is in **CSV, TSV, or unstructured text** that needs parsing
- You want to **join data from multiple sources**

### The transform_data Tool

`transform_data` runs a script in an isolated subprocess that reads input files and writes structured JSON output.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `language` | `"python3"` \| `"node"` \| `"bun"` | Script runtime |
| `script` | string | Transform script source code |
| `inputFiles` | string[] | Input file paths relative to session dir |
| `outputFile` | string | Output file name (written to session `data/` dir) |

**Path conventions:**
- **Input files** are relative to the session directory. Common locations:
  - `long_responses/tool_result_abc.txt` — saved tool results
  - `data/previous_output.json` — output from a prior transform
  - `attachments/data.csv` — user-attached files
- **Output file** is relative to the session `data/` directory. Just provide the filename (e.g., `"transactions.json"`)

**Script argument conventions:**
- Input file paths are passed as positional command-line arguments
- The **last argument** is always the output file path
- Python: `sys.argv[1:-1]` = input files, `sys.argv[-1]` = output path
- Node/Bun: `process.argv.slice(2, -1)` = input files, `process.argv.at(-1)` = output path

### Output JSON Schema

The output file should contain valid JSON in one of these formats:

**Full format (recommended):**
```json
{
  "title": "Recent Transactions",
  "columns": [
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" }
  ],
  "rows": [
    { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
  ]
}
```

**Rows-only format:**
```json
{
  "rows": [
    { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
  ]
}
```

Or just a bare array:
```json
[
  { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
]
```

**Merge semantics:** When using `"src"`, inline `columns` and `title` in the markdown block take precedence over values in the file. This lets you define column types in the block while pulling rows from the file.

### Referencing the Output

After `transform_data` succeeds, it returns the **absolute path** to the output file. Use that exact path as the `"src"` value in your datatable or spreadsheet block:

````
```datatable
{
  "src": "/absolute/path/returned/by/transform_data",
  "title": "Recent Transactions",
  "columns": [
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" }
  ]
}
```
````

**Important:** Always use the absolute path from the `transform_data` tool result. Do not construct relative paths manually.

### Complete Workflow Example

User asks: "Show me all Stripe transactions from last month"

**Step 1:** Call the Stripe API via MCP tool — get large JSON response

**Step 2:** Call `transform_data` to extract and structure the data:
```
transform_data({
  language: "python3",
  script: "import json, sys\nwith open(sys.argv[1]) as f:\n    data = json.load(f)\nrows = [{\n    'id': t['id'],\n    'date': t['created'],\n    'amount': t['amount'] / 100,\n    'status': t['status'].title(),\n    'customer': t.get('customer_email', 'N/A')\n} for t in data.get('data', data.get('transactions', []))]\nwith open(sys.argv[-1], 'w') as f:\n    json.dump({'rows': rows}, f)",
  inputFiles: ["long_responses/stripe_result.txt"],
  outputFile: "transactions.json"
})
```

**Step 3:** Output the datatable block using the absolute path from `transform_data` result:
````
```datatable
{
  "src": "/absolute/path/from/transform_data/result",
  "title": "Stripe Transactions — Last Month",
  "columns": [
    { "key": "id", "label": "ID", "type": "text" },
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" },
    { "key": "customer", "label": "Customer", "type": "text" }
  ]
}
```
````

## Common Patterns & Recipes

### JSON API Response → Datatable

Most common pattern. Extract fields from a JSON API response:

**Python:**
```python
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

# Handle common API response shapes
items = data.get('data', data.get('items', data.get('results', data)))
if not isinstance(items, list):
    items = [items]

rows = [{
    'id': item['id'],
    'name': item.get('name', ''),
    'created': item.get('created_at', ''),
} for item in items]

with open(sys.argv[-1], 'w') as f:
    json.dump({'rows': rows}, f)
```

### CSV/TSV → Spreadsheet

Parse CSV data into a spreadsheet for export:

**Python:**
```python
import csv, json, sys

with open(sys.argv[1]) as f:
    reader = csv.DictReader(f)
    rows = list(reader)

# Auto-detect columns from CSV headers
columns = [{'key': k, 'label': k.replace('_', ' ').title(), 'type': 'text'} for k in rows[0].keys()] if rows else []

with open(sys.argv[-1], 'w') as f:
    json.dump({'columns': columns, 'rows': rows}, f)
```

### Multi-Source Join

Combine data from multiple tool results:

**Python:**
```python
import json, sys

# sys.argv[1:-1] are input files, sys.argv[-1] is output
with open(sys.argv[1]) as f:
    users = {u['id']: u for u in json.load(f)['data']}
with open(sys.argv[2]) as f:
    orders = json.load(f)['data']

rows = [{
    'order_id': o['id'],
    'customer': users.get(o['user_id'], {}).get('name', 'Unknown'),
    'amount': o['total'],
    'status': o['status'],
} for o in orders]

with open(sys.argv[-1], 'w') as f:
    json.dump({'rows': rows}, f)
```

Call with:
```
transform_data({
  language: "python3",
  script: "...",
  inputFiles: ["long_responses/users.txt", "long_responses/orders.txt"],
  outputFile: "orders-with-customers.json"
})
```

### Filtering & Aggregation

Summarize data before display:

**Python:**
```python
import json, sys
from collections import defaultdict

with open(sys.argv[1]) as f:
    data = json.load(f)

# Group by category and sum
totals = defaultdict(lambda: {'count': 0, 'total': 0})
for item in data['transactions']:
    cat = item.get('category', 'Other')
    totals[cat]['count'] += 1
    totals[cat]['total'] += item['amount']

rows = [{'category': k, 'count': v['count'], 'total': v['total']}
        for k, v in sorted(totals.items(), key=lambda x: -x[1]['total'])]

with open(sys.argv[-1], 'w') as f:
    json.dump({'rows': rows}, f)
```

### Node.js Alternative

When Python isn't available or you prefer JavaScript:

**Node:**
```javascript
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));

const rows = data.items.map(item => ({
  id: item.id,
  title: item.title,
  status: item.state,
  created: item.created_at,
}));

fs.writeFileSync(process.argv.at(-1), JSON.stringify({ rows }));
```

## Security & Constraints

- **Isolated subprocess:** Scripts run in a child process with no access to API keys, credentials, or sensitive environment variables
- **30-second timeout:** Scripts that exceed 30 seconds are killed
- **Path sandboxing:** Input files must be within the session directory. Output files must be within the session `data/` directory. Path traversal attempts (e.g., `../`) are blocked.
- **No network access:** Scripts inherit the process environment (minus secrets) but should not make network calls — use MCP tools for data fetching, then transform locally
- **Blocked env vars:** `AWS_*`, `GITHUB_TOKEN`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY`, `NPM_TOKEN`, and other configured secret variables

## Best Practices

### Decision Tree

```
Is the data < 20 rows?
  → YES: Inline it directly in the datatable/spreadsheet block
  → NO: Use transform_data + "src" field

Is the data already structured JSON?
  → YES: Write a simple extraction script
  → NO: Use Python's csv, json, or string parsing to structure it

Does the user need to export/download?
  → YES: Use spreadsheet block (supports .xlsx export)
  → NO: Use datatable block (better sort/filter/group UX)
```

### Naming Conventions

- Output files: descriptive, kebab-case — `stripe-transactions.json`, `monthly-revenue.json`
- Match the context — if user asked about "Q4 sales", name it `q4-sales.json`

### Error Handling in Scripts

- Always validate input data exists before processing
- Use `try/except` (Python) or `try/catch` (Node) for JSON parsing
- Write partial results if possible — some data is better than an error
- Keep scripts concise — complex logic is harder to debug in the 30s timeout

### Script Tips

- Prefer Python for data transformation — it's the most reliable runtime for JSON/CSV processing
- Keep scripts self-contained — no `pip install` or external dependencies
- Use `json.dump` with default serialization — don't try to format numbers in the script; let column types handle rendering
- For dates, output ISO format strings (`YYYY-MM-DD`) — the `date` column type handles formatting

## Troubleshooting

### "Script failed (exit code 1)"
- Check the error output for syntax errors or missing imports
- Verify input files exist at the specified paths
- Make sure the script reads from `sys.argv` / `process.argv` correctly

### "Output file was not created"
- Ensure the script writes to `sys.argv[-1]` / `process.argv.at(-1)` (the last argument)
- Check that `json.dump` / `fs.writeFileSync` completed successfully
- Verify the output is valid JSON

### "Input file not found"
- Input paths are relative to the session directory
- Check the exact path from the tool result that produced the file
- Use `long_responses/` prefix for saved tool results, `attachments/` for user-uploaded files

### Empty or missing rows in table
- Verify the JSON structure: must have `"rows"` key with an array, or be a bare array
- Check that row keys match the column `"key"` fields exactly (case-sensitive)
- Ensure values match expected types (numbers for `currency`/`percent`, not strings)

### Table shows "Loading..." indefinitely
- The `"src"` path must be the **absolute path** returned by `transform_data` — do not use relative paths
- Verify the file was actually created by `transform_data` (check the tool result message)
