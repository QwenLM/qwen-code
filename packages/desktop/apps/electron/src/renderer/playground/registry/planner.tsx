import * as React from 'react'
import type { ComponentEntry } from './types'
import { DragDropManager } from '@dnd-kit/dom'
import { Sortable } from '@dnd-kit/dom/sortable'
import {
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock3,
  CloudAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  History,
  MoreHorizontal,
  Link2,
  ListTodo,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MetadataBadge } from '@/components/ui/metadata-badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { TiptapMarkdownEditor } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { getResizeGradientStyle } from '@/hooks/useResizeGradient'
import {
  PANEL_GAP,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from '@/components/app-shell/panel-constants'
import './planner.css'

type TaskState = 'todo' | 'in_progress' | 'done' | 'cancelled'
type SyncState = 'local_only' | 'pending_upload' | 'uploaded' | 'remote_only' | 'unavailable' | 'upload_failed'
type PlannerEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.cancelled'
  | 'task.reopened'
  | 'task.moved'
  | 'task.session_linked'
  | 'task.session_unlinked'
  | 'task.session_snapshot_updated'

type PlannerRow =
  | { kind: 'heading'; headingId: string; key: string }
  | { kind: 'task'; taskId: string; key: string }

interface SessionSnapshot {
  id: string
  title: string
  summary: string
  lastUpdated: string
}

interface TaskSessionLinkLocal {
  id: string
  taskId: string
  snapshotId: string
  syncState: SyncState
}

interface PlannerTaskEvent {
  id: string
  taskId: string
  type: PlannerEventType
  at: string
  actor: string
  payloadSummary: string
}

interface PlannerTask {
  id: string
  headingId: string
  title: string
  notes: string
  state: TaskState
  due: string
}

interface PlannerHeading {
  id: string
  projectId: string
  title: string
  sortOrder: number
}

interface PlannerProject {
  id: string
  name: string
  status: 'open' | 'archived'
  sortOrder: number
  installationHint: string
  memberCount: number
}

const projects: PlannerProject[] = [
  { id: 'p1', name: 'Personal', status: 'open', sortOrder: 1, installationHint: 'MacBook · my-workspace', memberCount: 1 },
  { id: 'p2', name: 'Planner V2', status: 'open', sortOrder: 2, installationHint: 'MacBook · my-workspace', memberCount: 3 },
  { id: 'p3', name: 'Craft App', status: 'open', sortOrder: 3, installationHint: 'Import mounted locally', memberCount: 4 },
  { id: 'p4', name: 'Markdown Samples', status: 'open', sortOrder: 4, installationHint: 'Editor test fixtures', memberCount: 1 },
]

const initialHeadings: PlannerHeading[] = [
  { id: 'h1', projectId: 'p2', title: 'Today', sortOrder: 1 },
  { id: 'h2', projectId: 'p2', title: 'Upcoming', sortOrder: 2 },
  { id: 'h3', projectId: 'p2', title: 'Later', sortOrder: 3 },
  { id: 'h4', projectId: 'p4', title: 'Diagrams & Visuals', sortOrder: 1 },
  { id: 'h5', projectId: 'p4', title: 'Code & Math', sortOrder: 2 },
  { id: 'h6', projectId: 'p4', title: 'Long-form & Mixed', sortOrder: 3 },
]

const initialTasks: PlannerTask[] = [
  {
    id: 't1',
    headingId: 'h1',
    title: 'Build planner shell in playground',
    notes: 'Three-pane layout with **projects**, **headings**, **tasks**, and detail view.\n\n## Requirements\n- Keep rhythm calm and lightweight\n- Panels should match the main app chrome\n- Resize handles with gradient feedback\n\n> The detail pane should feel like Linear\'s issue view.',
    state: 'in_progress',
    due: 'Today · 21:00',
  },
  {
    id: 't2',
    headingId: 'h1',
    title: 'Add linked session cards with sync-state badges',
    notes: 'Snapshots should remain useful even if session cannot be resolved.\n\n**Sync states:**\n1. `local_only` — not yet uploaded\n2. `pending_upload` — queued for sync\n3. `uploaded` — confirmed on server\n4. `remote_only` — server-side only\n5. `unavailable` — session deleted\n6. `upload_failed` — retry needed',
    state: 'todo',
    due: 'Today · 22:00',
  },
  {
    id: 't5',
    headingId: 'h1',
    title: 'Wire up drag-to-reorder between headings',
    notes: 'Tasks dragged across heading boundaries should update their headingId.',
    state: 'done',
    due: 'Today · 14:00',
  },
  {
    id: 't6',
    headingId: 'h1',
    title: 'Keyboard navigation for task list',
    notes: 'Arrow keys to move selection, Enter to open detail, Escape to deselect.',
    state: 'todo',
    due: 'Today · 23:00',
  },
  {
    id: 't7',
    headingId: 'h1',
    title: 'Quick-add input autofocus on Cmd+N',
    notes: 'Global shortcut should focus the input and select all text.',
    state: 'done',
    due: 'Today · 12:00',
  },
  {
    id: 't3',
    headingId: 'h2',
    title: 'Task timeline tab with append-only events',
    notes: 'Map event types from task_events table to readable timeline rows.',
    state: 'todo',
    due: 'Tomorrow',
  },
  {
    id: 't8',
    headingId: 'h2',
    title: 'Portable core: SQLite schema for tasks + headings',
    notes: 'Design tables with **WAL mode**, CRDT-friendly IDs, and `sort_order` columns.\n\n### Tables\n- `tasks` — id, title, notes, state, heading_id, sort_order\n- `headings` — id, title, project_id, sort_order\n- `task_events` — id, task_id, type, payload, created_at\n- `task_session_links` — id, task_id, snapshot_id, sync_state',
    state: 'todo',
    due: 'Tomorrow',
  },
  {
    id: 't9',
    headingId: 'h2',
    title: 'Sync engine: conflict resolution strategy',
    notes: 'Last-write-wins per field with vector clocks.\n\n## Trade-offs\n- **LWW** is simple but can lose concurrent edits\n- **CRDTs** are correct but add complexity\n- *Hybrid*: LWW for scalar fields, CRDT for lists (sort_order)\n\n> Start with LWW and add conflict UI later if needed.',
    state: 'todo',
    due: 'Mar 2',
  },
  {
    id: 't10',
    headingId: 'h2',
    title: 'Session snapshot auto-refresh on task open',
    notes: 'When a task with linked sessions is selected, refresh stale snapshots in background.',
    state: 'todo',
    due: 'Mar 3',
  },
  {
    id: 't11',
    headingId: 'h2',
    title: 'Due date picker with natural language input',
    notes: 'Parse "tomorrow", "next friday", "in 3 days" into actual dates.',
    state: 'todo',
    due: 'Mar 4',
  },
  {
    id: 't4',
    headingId: 'h3',
    title: 'Project sharing UX (members + roles)',
    notes: 'Project ACL root with owner/editor/viewer hints.',
    state: 'cancelled',
    due: 'Next week',
  },
  {
    id: 't12',
    headingId: 'h3',
    title: 'Multi-workspace task views',
    notes: 'Aggregate tasks from multiple workspaces into a unified "My Tasks" view.',
    state: 'todo',
    due: 'Mar 10',
  },
  {
    id: 't13',
    headingId: 'h3',
    title: 'Recurring tasks with cron-like schedules',
    notes: 'Support daily, weekly, monthly recurrence with skip/snooze options.',
    state: 'todo',
    due: 'Mar 15',
  },
  {
    id: 't14',
    headingId: 'h3',
    title: 'Task templates from session transcripts',
    notes: 'Extract action items from a session and create tasks with pre-filled notes.',
    state: 'todo',
    due: 'Mar 20',
  },
  {
    id: 't15',
    headingId: 'h3',
    title: 'Archive completed tasks after 7 days',
    notes: 'Auto-archive with undo. Archived tasks visible in a separate filtered view.',
    state: 'todo',
    due: 'Later',
  },
  {
    id: 't16',
    headingId: 'h3',
    title: 'Notification badges for overdue tasks',
    notes: 'Red dot on project sidebar item when tasks are past due.',
    state: 'todo',
    due: 'Later',
  },
  // ── Markdown Samples project (p4) ──
  {
    id: 'ms1',
    headingId: 'h4',
    title: 'Mermaid: Data flow diagram',
    notes: 'Document the full data pipeline from user action to persistence.\n\n```mermaid\ngraph LR\n    A[User Action] --> B[React State]\n    B --> C[SQLite WAL]\n    C --> D[Sync Engine]\n    D --> E[Remote API]\n    E --> F[Conflict Resolution]\n    F --> C\n```\n\n![Planner pipeline board mock](https://picsum.photos/seed/planner-pipeline/1200/620 "Planner pipeline mock")\n\nThe sync engine should handle **offline-first** writes and queue them for upload when connectivity resumes.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms2',
    headingId: 'h4',
    title: 'Mermaid: State machine',
    notes: 'Task lifecycle as a state diagram.\n\n```mermaid\nstateDiagram-v2\n    [*] --> todo\n    todo --> in_progress: Start\n    in_progress --> done: Complete\n    in_progress --> todo: Pause\n    todo --> cancelled: Cancel\n    in_progress --> cancelled: Cancel\n    done --> todo: Reopen\n    cancelled --> todo: Reopen\n```\n\nEvery transition emits an **event** to the append-only `task_events` table.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms3',
    headingId: 'h4',
    title: 'Mermaid: Sequence diagram',
    notes: 'Sync protocol between client and server.\n\n```mermaid\nsequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: POST /sync (events[])\n    S-->>C: 200 OK (ack + remote events)\n    C->>C: Apply remote events\n    C->>C: Resolve conflicts (LWW)\n    Note over C,S: Retry with exponential backoff on failure\n```',
    state: 'done',
    due: '',
  },
  {
    id: 'ms4',
    headingId: 'h5',
    title: 'Code: TypeScript — Fractional indexing',
    notes: 'Use fractional indexing for `sort_order` to avoid renumbering on every reorder.\n\n```typescript\nfunction midpoint(a: string, b: string): string {\n  // Generate a string between a and b lexicographically\n  const aCode = a.charCodeAt(0) || 96 // \'a\' - 1\n  const bCode = b.charCodeAt(0) || 123 // \'z\' + 1\n  const mid = Math.floor((aCode + bCode) / 2)\n  if (mid === aCode) {\n    return a + String.fromCharCode(\n      Math.floor((97 + (b.charCodeAt(1) || 123)) / 2)\n    )\n  }\n  return String.fromCharCode(mid)\n}\n```\n\n### Edge cases\n- Inserting at the very beginning (before `\"a\"`)\n- Inserting at the very end (after `\"z\"`)\n- Exhausting the single-char keyspace → must extend with a second character\n\n> See also: [Implementing Fractional Indexing](https://observablehq.com/@dgreensp/implementing-fractional-indexing) by David Greenspan.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms5',
    headingId: 'h5',
    title: 'Code: SQL — Query benchmarks',
    notes: 'Benchmark the critical SQLite queries.\n\n```sql\n-- Tasks by heading (hot path)\nSELECT id, title, state, sort_order\nFROM tasks\nWHERE heading_id = ?\nORDER BY sort_order;\n\n-- Overdue tasks across all projects\nSELECT t.id, t.title, t.due_at, h.title AS heading\nFROM tasks t\nJOIN headings h ON h.id = t.heading_id\nWHERE t.due_at < datetime(\'now\')\n  AND t.state NOT IN (\'done\', \'cancelled\')\nORDER BY t.due_at ASC;\n\n-- Event timeline for a task\nSELECT type, payload, created_at\nFROM task_events\nWHERE task_id = ?\nORDER BY created_at DESC\nLIMIT 50;\n```\n\nTarget: all queries under **5ms** with indices on `heading_id`, `due_at`, and `task_id`.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms6',
    headingId: 'h5',
    title: 'Code: JSON — API contract',
    notes: 'REST API surface for task CRUD.\n\n```json\n{\n  "POST /tasks": {\n    "body": { "title": "string", "headingId": "string", "notes?": "string" },\n    "response": { "id": "string", "createdAt": "ISO8601" }\n  },\n  "PATCH /tasks/:id": {\n    "body": { "title?": "string", "state?": "TaskState", "notes?": "string" },\n    "response": { "updatedAt": "ISO8601" }\n  },\n  "DELETE /tasks/:id": {\n    "response": 204\n  }\n}\n```\n\nAll mutations return an `ETag` header for **optimistic concurrency control**.',
    state: 'done',
    due: '',
  },
  {
    id: 'ms7',
    headingId: 'h5',
    title: 'Math: Priority scoring formula',
    notes: 'Design a priority scoring system that combines urgency and importance.\n\nThe **Eisenhower weight** can be modeled as:\n\n$$P = w_u \\cdot U + w_i \\cdot I + \\lambda \\cdot e^{-\\Delta t / \\tau}$$\n\nWhere:\n- $$U$$ = urgency score (0–10)\n- $$I$$ = importance score (0–10)\n- $$\\Delta t$$ = time until due date\n- $$\\tau$$ = decay constant (e.g. 7 days)\n- $$w_u, w_i$$ = tunable weights\n- $$\\lambda$$ = deadline pressure coefficient\n\nDefault weights: $$w_u = 0.4$$, $$w_i = 0.6$$, $$\\lambda = 2.0$$, $$\\tau = 7$$.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms8',
    headingId: 'h5',
    title: 'Math: Information entropy',
    notes: 'Shannon entropy for measuring task distribution across headings.\n\n$$H(X) = -\\sum_{i=1}^{n} p(x_i) \\log_2 p(x_i)$$\n\nFor a balanced distribution across $$n$$ headings:\n\n$$H_{max} = \\log_2(n)$$\n\nAn **imbalance score** can be derived as:\n\n$$\\text{imbalance} = 1 - \\frac{H(X)}{H_{max}}$$\n\nValues close to 0 mean tasks are evenly spread; close to 1 means everything is piled in one section.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms9',
    headingId: 'h6',
    title: 'Long-form: Full architecture spec',
    notes: '# Planner V2 Architecture\n\nThis document outlines the **complete architecture** for the Planner V2 system.\n\n## Overview\n\nThe planner is a *three-layer* system:\n\n1. **Presentation layer** — React components with Tiptap editors\n2. **State layer** — SQLite with WAL mode, exposed via typed queries\n3. **Sync layer** — Offline-first CRDT sync with conflict resolution\n\n![Architecture concept sketch](https://picsum.photos/seed/planner-arch-spec/1280/720 "Architecture concept")\n\n## Data Model\n\nCore entities:\n- **Project** — top-level container with ACL\n- **Heading** — ordered sections within a project\n- **Task** — individual work items with state machine\n- **Event** — append-only audit log\n- **SessionLink** — references to agent sessions\n\n## Task State Machine\n\n```mermaid\nstateDiagram-v2\n    [*] --> todo\n    todo --> in_progress: Start\n    in_progress --> done: Complete\n    in_progress --> todo: Pause\n    todo --> cancelled: Cancel\n    in_progress --> cancelled: Cancel\n    done --> todo: Reopen\n    cancelled --> todo: Reopen\n```\n\n## Sync Protocol\n\nEach mutation produces a **sync event** that is:\n1. Applied locally (optimistic)\n2. Queued in `sync_outbox` table\n3. Sent to server when online\n4. Acknowledged with server timestamp\n5. Conflicts resolved via LWW per field\n\n> The sync engine must handle **network partitions** gracefully. Tasks created offline should sync without data loss when connectivity is restored.\n\n## Performance Targets\n\n| Metric | Target |\n|--------|--------|\n| Task list render | < 16ms |\n| Task create (local) | < 5ms |\n| Sync round-trip | < 200ms |\n| Offline queue capacity | 10,000 events |\n\n## Open Questions\n\n- Should we support **real-time collaboration** (multiple users editing the same task)?\n- How do we handle **schema migrations** for the SQLite database?\n- What is the **retention policy** for events?',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms10',
    headingId: 'h6',
    title: 'Mixed: Accessibility audit',
    notes: 'Ensure the task list meets **WCAG 2.1 AA** standards.\n\n### Checklist\n- [ ] All interactive elements have `aria-label` or visible label\n- [ ] Drag-and-drop has keyboard alternative\n- [ ] Focus management after task creation/deletion\n- [ ] Color contrast ratios ≥ 4.5:1 for text\n- [ ] Screen reader announces state changes\n- [ ] `role="listbox"` on task list, `role="option"` on items\n\n### Keyboard Shortcuts\n| Key | Action |\n|-----|--------|\n| `↑` / `↓` | Move selection |\n| `Enter` | Open detail |\n| `Escape` | Close detail |\n| `Space` | Toggle state |\n| `Cmd+N` | New task |\n| `Delete` | Cancel task |\n\n> Run [axe-core](https://www.deque.com/axe/) scan before each release.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms11',
    headingId: 'h6',
    title: 'Mixed: Code + Diagram + Math combined',
    notes: '## Sync Conflict Resolution\n\nWhen two clients edit the same field, we use **last-write-wins** with Lamport timestamps.\n\n### Algorithm\n\n```typescript\nfunction resolve<T>(local: Versioned<T>, remote: Versioned<T>): T {\n  if (remote.timestamp > local.timestamp) return remote.value\n  if (remote.timestamp < local.timestamp) return local.value\n  // Tie-break by client ID (lexicographic)\n  return remote.clientId > local.clientId\n    ? remote.value\n    : local.value\n}\n```\n\n### Convergence proof\n\nFor $$n$$ clients with unique IDs, the resolution function is:\n- **Commutative**: $$f(a, b) = f(b, a)$$ for equal timestamps\n- **Idempotent**: $$f(a, a) = a$$\n- **Associative**: $$f(f(a, b), c) = f(a, f(b, c))$$\n\nThis guarantees all replicas converge to the same state.\n\n### Flow\n\n```mermaid\ngraph TD\n    A[Local Write] --> B{Conflict?}\n    B -->|No| C[Apply directly]\n    B -->|Yes| D[Compare timestamps]\n    D --> E{Remote wins?}\n    E -->|Yes| F[Apply remote]\n    E -->|No| G[Keep local]\n    F --> H[Emit reconciled event]\n    G --> H\n```\n\n> This approach trades *correctness under concurrent edits* for **simplicity**. A future version could use operation-based CRDTs for richer merge semantics.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms12',
    headingId: 'h6',
    title: 'Prose: Rich formatting showcase',
    notes: 'This task demonstrates all **basic** formatting.\n\n## Headings work\n\n### And sub-headings too\n\nHere is some *italic text*, some **bold text**, and some ***bold italic***. We also have `inline code` and ~~strikethrough~~.\n\n## Lists\n\nUnordered:\n- First item\n- Second item with **bold** inside\n  - Nested item\n  - Another nested one\n- Third item\n\nOrdered:\n1. Step one\n2. Step two\n3. Step three\n\n## Blockquotes\n\n> This is a quote.\n> It can span multiple lines.\n>\n> And even have **formatting** inside.\n\n## Links, images, and code\n\nVisit [Craft](https://craft.do) for more info.\n\n![Rich formatting sample image](https://picsum.photos/seed/planner-rich-formatting/1100/520 "Rich formatting sample")\n\n```bash\n# A simple shell script\nfor i in $(seq 1 5); do\n  echo \"Task $i completed\"\ndone\n```\n\n---\n\nThat horizontal rule above separates sections nicely.',
    state: 'done',
    due: '',
  },
]

const snapshots: SessionSnapshot[] = [
  {
    id: 's1',
    title: 'Planner architecture review',
    summary: 'Validated portable core + local integration split; queued DB schema migration checklist.',
    lastUpdated: '5 min ago',
  },
  {
    id: 's2',
    title: 'Drag interaction tuning',
    summary: 'Following the same dnd-kit/dom path as the vertical sample for consistency.',
    lastUpdated: '1 hour ago',
  },
]

const sessionLinks: TaskSessionLinkLocal[] = [
  { id: 'l1', taskId: 't1', snapshotId: 's1', syncState: 'uploaded' },
  { id: 'l2', taskId: 't1', snapshotId: 's2', syncState: 'pending_upload' },
  { id: 'l3', taskId: 't2', snapshotId: 's1', syncState: 'unavailable' },
]

const events: PlannerTaskEvent[] = [
  { id: 'e1', taskId: 't1', type: 'task.created', at: 'Today · 18:12', actor: 'Balint', payloadSummary: 'Task created in Today heading' },
  { id: 'e2', taskId: 't1', type: 'task.session_linked', at: 'Today · 18:20', actor: 'Balint', payloadSummary: 'Linked session snapshot s1' },
  { id: 'e3', taskId: 't1', type: 'task.updated', at: 'Today · 18:27', actor: 'Balint', payloadSummary: 'Updated notes and due date' },
  { id: 'e4', taskId: 't1', type: 'task.session_snapshot_updated', at: 'Today · 18:42', actor: 'Craft Agent', payloadSummary: 'Refreshed snapshot summary' },
]

const stateStyles: Record<TaskState, string> = {
  todo: 'text-foreground/45',
  in_progress: 'text-info',
  done: 'text-success',
  cancelled: 'text-destructive/70',
}

const stateLabels: Record<TaskState, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

const syncMeta: Record<SyncState, { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  local_only: { label: 'Local only', icon: CloudOff, cls: 'text-foreground/55 bg-foreground/7' },
  pending_upload: { label: 'Pending upload', icon: CloudUpload, cls: 'text-info bg-info/12' },
  uploaded: { label: 'Uploaded', icon: CloudCheck, cls: 'text-success bg-success/12' },
  remote_only: { label: 'Remote only', icon: CloudCheck, cls: 'text-accent bg-accent/12' },
  unavailable: { label: 'Unavailable', icon: CloudAlert, cls: 'text-warning bg-warning/12' },
  upload_failed: { label: 'Upload failed', icon: CloudAlert, cls: 'text-destructive bg-destructive/12' },
}

interface PlannerSortableEntry {
  sortable: Sortable
  element: HTMLDivElement
  index: number
}

function buildFlatOrder(projectHeadings: PlannerHeading[], tasks: PlannerTask[]): string[] {
  const rows: string[] = []

  projectHeadings.forEach((heading) => {
    rows.push(`heading:${heading.id}`)
    tasks
      .filter(task => task.headingId === heading.id)
      .forEach(task => rows.push(`task:${task.id}`))
  })

  return rows
}

function parseHeadingIdFromKey(rowKey: string): string | null {
  return rowKey.startsWith('heading:') ? rowKey.slice('heading:'.length) : null
}

function parseTaskIdFromKey(rowKey: string): string | null {
  return rowKey.startsWith('task:') ? rowKey.slice('task:'.length) : null
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

function PlannerBoard() {
  const [activeProjectId, setActiveProjectId] = React.useState('p2')
  const [headingsState, setHeadingsState] = React.useState<PlannerHeading[]>(initialHeadings)
  const [tasksState, setTasksState] = React.useState<PlannerTask[]>(initialTasks)
  const [selectedTaskId, setSelectedTaskId] = React.useState('t1')
  const [quickAdd, setQuickAdd] = React.useState('')
  const [sidebarWidth, setSidebarWidth] = React.useState(220)
  const [navigatorWidth, setNavigatorWidth] = React.useState(420)
  const [isResizing, setIsResizing] = React.useState<'sidebar' | 'navigator' | null>(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)
  const [navigatorHandleY, setNavigatorHandleY] = React.useState<number | null>(null)
  const sidebarHandleRef = React.useRef<HTMLDivElement>(null)
  const navigatorHandleRef = React.useRef<HTMLDivElement>(null)
  const [flatOrder, setFlatOrder] = React.useState<string[]>(() => {
    const initialProjectHeadings = initialHeadings
      .filter(h => h.projectId === 'p2')
      .sort((a, b) => a.sortOrder - b.sortOrder)
    return buildFlatOrder(initialProjectHeadings, initialTasks)
  })

  const flatListRef = React.useRef<HTMLDivElement | null>(null)
  const rowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const managerRef = React.useRef<DragDropManager | null>(null)
  const sortableRegistryRef = React.useRef<Map<string, PlannerSortableEntry>>(new Map())
  const headingsStateRef = React.useRef(headingsState)
  const tasksStateRef = React.useRef(tasksState)
  const activeProjectIdRef = React.useRef(activeProjectId)
  const isDraggingRef = React.useRef(false)

  const project = projects.find(p => p.id === activeProjectId) ?? projects[0]
  const projectHeadings = React.useMemo(
    () => headingsState.filter(h => h.projectId === project.id).sort((a, b) => a.sortOrder - b.sortOrder),
    [headingsState, project.id]
  )

  const selectedTask = tasksState.find(t => t.id === selectedTaskId)
  const selectedLinks = sessionLinks.filter(link => link.taskId === selectedTaskId)
  const selectedEvents = events.filter(e => e.taskId === selectedTaskId)

  const flatRows = React.useMemo<PlannerRow[]>(() => {
    const headingById = new Map(projectHeadings.map(heading => [heading.id, heading]))
    const taskById = new Map(tasksState.map(task => [task.id, task]))

    return flatOrder
      .map((rowKey) => {
        const headingId = parseHeadingIdFromKey(rowKey)
        if (headingId) {
          if (!headingById.has(headingId)) return null
          return { kind: 'heading', headingId, key: rowKey } as PlannerRow
        }

        const taskId = parseTaskIdFromKey(rowKey)
        if (taskId) {
          const task = taskById.get(taskId)
          if (!task) return null
          if (!headingById.has(task.headingId)) return null
          return { kind: 'task', taskId, key: rowKey } as PlannerRow
        }

        return null
      })
      .filter((row): row is PlannerRow => Boolean(row))
  }, [flatOrder, projectHeadings, tasksState])

  React.useEffect(() => {
    headingsStateRef.current = headingsState
  }, [headingsState])

  React.useEffect(() => {
    tasksStateRef.current = tasksState
  }, [tasksState])

  React.useEffect(() => {
    activeProjectIdRef.current = activeProjectId
  }, [activeProjectId])

  React.useEffect(() => {
    const canonical = buildFlatOrder(projectHeadings, tasksState)
    setFlatOrder((prev) => {
      const canonicalSet = new Set(canonical)
      const preserved = uniqueOrdered(prev.filter(key => canonicalSet.has(key)))
      const missing = canonical.filter(key => !preserved.includes(key))
      const next = uniqueOrdered([...preserved, ...missing])

      const unchanged = next.length === prev.length && next.every((key, index) => key === prev[index])
      return unchanged ? prev : next
    })
  }, [projectHeadings, tasksState])

  React.useEffect(() => {
    if (!selectedTask || !projectHeadings.some(h => h.id === selectedTask.headingId)) {
      const firstTask = tasksState.find(t => projectHeadings.some(h => h.id === t.headingId))
      setSelectedTaskId(firstTask?.id ?? '')
    }
  }, [projectHeadings, tasksState, selectedTask])

  const applyFlatOrderToState = React.useCallback((orderedKeys: string[]) => {
    const activeProject = activeProjectIdRef.current
    const headings = headingsStateRef.current
    const tasks = tasksStateRef.current
    const taskById = new Map(tasks.map(task => [task.id, task]))
    const normalizedOrderedKeys = uniqueOrdered(orderedKeys)

    const projectHeadingIds = new Set(
      headings
        .filter(heading => heading.projectId === activeProject)
        .map(heading => heading.id)
    )

    const orderedHeadingIds = uniqueOrdered(
      normalizedOrderedKeys
        .map(parseHeadingIdFromKey)
        .filter((headingId): headingId is string => Boolean(headingId && projectHeadingIds.has(headingId)))
    )

    if (orderedHeadingIds.length === 0) return

    const orderedTaskIds: string[] = []
    const seenTaskIds = new Set<string>()
    const nextHeadingByTaskId = new Map<string, string>()
    let currentHeadingId = orderedHeadingIds[0]

    normalizedOrderedKeys.forEach((rowKey) => {
      const headingId = parseHeadingIdFromKey(rowKey)
      if (headingId && projectHeadingIds.has(headingId)) {
        currentHeadingId = headingId
        return
      }

      const taskId = parseTaskIdFromKey(rowKey)
      if (!taskId) return
      if (seenTaskIds.has(taskId)) return

      const task = taskById.get(taskId)
      if (!task) return
      if (!projectHeadingIds.has(task.headingId)) return

      seenTaskIds.add(taskId)
      orderedTaskIds.push(taskId)
      nextHeadingByTaskId.set(taskId, currentHeadingId)
    })

    setHeadingsState((prev) => {
      const nextOrderByHeadingId = new Map(orderedHeadingIds.map((id, index) => [id, index + 1]))
      return prev.map((heading) => {
        if (heading.projectId !== activeProject) return heading
        const sortOrder = nextOrderByHeadingId.get(heading.id)
        return sortOrder ? { ...heading, sortOrder } : heading
      })
    })

    setTasksState((prev) => {
      const updated = prev.map((task) => {
        const nextHeadingId = nextHeadingByTaskId.get(task.id)
        if (!nextHeadingId || task.headingId === nextHeadingId) return task
        return { ...task, headingId: nextHeadingId }
      })

      const byId = new Map(updated.map(task => [task.id, task]))
      const ordered = orderedTaskIds.map(taskId => byId.get(taskId)).filter((task): task is PlannerTask => Boolean(task))
      const remaining = updated.filter(task => !orderedTaskIds.includes(task.id))
      return [...ordered, ...remaining]
    })
  }, [])

  React.useEffect(() => {
    const manager = new DragDropManager()
    const sortableRegistry = sortableRegistryRef.current
    managerRef.current = manager

    const unsubDragStart = manager.monitor.addEventListener('dragstart', () => {
      isDraggingRef.current = true
    })

    const unsubDragEnd = manager.monitor.addEventListener('dragend', (event) => {
      requestAnimationFrame(() => { isDraggingRef.current = false })
      if (event.canceled) return

      const sourceId = String(event.operation.source?.id ?? '')
      if (!sourceId.startsWith('heading:') && !sourceId.startsWith('task:')) return

      const list = flatListRef.current
      if (!list) return

      const orderedKeys = uniqueOrdered(
        Array.from(list.children)
          .map(el => (el as HTMLElement).dataset.rowKey)
          .filter((key): key is string => Boolean(key))
      )

      if (orderedKeys.length === 0) return

      setFlatOrder(orderedKeys)
      applyFlatOrderToState(orderedKeys)
    })

    return () => {
      unsubDragStart()
      unsubDragEnd()
      sortableRegistry.forEach((entry) => entry.sortable.destroy())
      sortableRegistry.clear()
      manager.destroy()
      managerRef.current = null
    }
  }, [applyFlatOrderToState])

  React.useEffect(() => {
    const manager = managerRef.current
    if (!manager) return

    const desiredEntries = new Map<string, { element: HTMLDivElement; index: number }>()

    flatRows.forEach((row, index) => {
      const element = rowRefs.current.get(row.key)
      if (!element) return

      desiredEntries.set(row.key, {
        element,
        index,
      })
    })

    desiredEntries.forEach((desired, rowKey) => {
      const existing = sortableRegistryRef.current.get(rowKey)

      if (existing) {
        if (existing.index !== desired.index) {
          existing.sortable.index = desired.index
          existing.index = desired.index
        }
        if (existing.element !== desired.element) {
          existing.sortable.element = desired.element
          existing.element = desired.element
        }
        return
      }

      const sortable = new Sortable({
        id: rowKey,
        index: desired.index,
        element: desired.element,
      }, manager)

      sortableRegistryRef.current.set(rowKey, {
        sortable,
        element: desired.element,
        index: desired.index,
      })
    })

    Array.from(sortableRegistryRef.current.keys()).forEach((rowKey) => {
      if (desiredEntries.has(rowKey)) return
      const existing = sortableRegistryRef.current.get(rowKey)
      existing?.sortable.destroy()
      sortableRegistryRef.current.delete(rowKey)
    })
  }, [flatRows])

  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = sidebarHandleRef.current?.parentElement
      const containerLeft = container?.getBoundingClientRect().left ?? 0

      if (isResizing === 'sidebar') {
        setSidebarWidth(Math.max(e.clientX - containerLeft, 160))
        if (sidebarHandleRef.current) {
          const rect = sidebarHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'navigator') {
        const offset = sidebarWidth + 6 // sidebar + gap
        setNavigatorWidth(Math.max(e.clientX - containerLeft - offset, 240))
        if (navigatorHandleRef.current) {
          const rect = navigatorHandleRef.current.getBoundingClientRect()
          setNavigatorHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      setIsResizing(null)
      setSidebarHandleY(null)
      setNavigatorHandleY(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sidebarWidth])

  const updateTaskTitle = React.useCallback((taskId: string, newTitle: string) => {
    const trimmed = newTitle.trim()
    if (!trimmed) return
    setTasksState(prev => prev.map(t => t.id === taskId ? { ...t, title: trimmed } : t))
  }, [])

  const updateTaskNotes = React.useCallback((taskId: string, newNotes: string) => {
    setTasksState(prev => prev.map(t => t.id === taskId ? { ...t, notes: newNotes } : t))
  }, [])

  const selectedHeading = selectedTask ? headingsState.find(h => h.id === selectedTask.headingId) : null

  const addTask = React.useCallback(() => {
    const title = quickAdd.trim()
    if (!title || projectHeadings.length === 0) return

    const task: PlannerTask = {
      id: `t-${Date.now()}`,
      headingId: projectHeadings[0].id,
      title,
      notes: '',
      state: 'todo',
      due: 'Inbox',
    }

    setTasksState(prev => [task, ...prev])
    setFlatOrder((prev) => {
      const firstHeadingKey = `heading:${projectHeadings[0].id}`
      const insertionIndex = prev.indexOf(firstHeadingKey)
      if (insertionIndex === -1) return [...prev, `task:${task.id}`]
      const next = [...prev]
      next.splice(insertionIndex + 1, 0, `task:${task.id}`)
      return next
    })
    setSelectedTaskId(task.id)
    setQuickAdd('')
  }, [projectHeadings, quickAdd])

  return (
    <div className="w-full h-full flex relative" style={{ gap: 6, padding: 4 }}>
      <aside
        className="p-3 shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
          <div className="mb-3 flex items-center gap-2 px-2 py-1">
            <ListTodo className="h-4 w-4 text-foreground/60" />
            <span className="text-sm font-semibold">Planner</span>
          </div>

          <div className="space-y-1">
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => setActiveProjectId(p.id)}
                className={cn(
                  'w-full rounded-[10px] px-2.5 py-2 text-left transition-colors',
                  p.id === project.id
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-foreground/65 hover:bg-foreground/5 hover:text-foreground'
                )}
              >
                <div className="text-sm font-medium">{p.name}</div>
                <div className="mt-0.5 text-[11px] text-foreground/45">{p.installationHint}</div>
              </button>
            ))}
          </div>
      </aside>

      <section
        className="bg-background shadow-middle rounded-[10px] overflow-hidden shrink-0 flex flex-col"
        style={{ width: navigatorWidth }}
      >
          <div className="border-b border-border/60 px-5 py-3">
            <h3 className="mb-2 text-base font-semibold">{project.name}</h3>
            <div className="flex gap-2">
              <Input
                value={quickAdd}
                onChange={(e) => setQuickAdd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTask()
                }}
                placeholder="Quick add task…"
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={addTask}>Add</Button>
            </div>
          </div>

          <ScrollArea
            className="flex-1"
            onPointerDown={(e) => {
              const target = e.target as HTMLElement
              if (target.closest('[data-row-key]')) return
              setSelectedTaskId('')
            }}
          >
            <div
              className="px-5 py-4 min-h-full flex flex-col"
            >
              <div
                ref={flatListRef}
                className="flex flex-col gap-1.5 rounded-[10px] p-1"
              >
                {flatRows.map((row, index) => {
                  if (row.kind === 'heading') {
                    const heading = projectHeadings.find(h => h.id === row.headingId)
                    if (!heading) return null

                    return (
                      <div
                        key={row.key}
                        data-row-key={row.key}
                        ref={(el) => {
                          if (el) rowRefs.current.set(row.key, el)
                          else rowRefs.current.delete(row.key)
                        }}
                        className={cn(
                          'w-full select-none',
                          index === 0 ? 'pt-1' : 'pt-3'
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-1.5 px-1">
                          <div className="text-[13px] font-semibold text-foreground">
                            {heading.title}
                          </div>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                data-no-dnd="true"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                className="h-6 w-6 inline-flex items-center justify-center rounded-[6px] hover:bg-foreground/5 data-[state=open]:bg-foreground/5"
                                aria-label={`Open ${heading.title} menu`}
                              >
                                <MoreHorizontal className="h-4 w-4 text-foreground/45" />
                              </button>
                            </DropdownMenuTrigger>
                            <StyledDropdownMenuContent align="end" minWidth="min-w-44">
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Rename section</span>
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Add task below</span>
                              </StyledDropdownMenuItem>
                              <StyledDropdownMenuItem onClick={(e) => e.preventDefault()}>
                                <span className="flex-1">Delete section</span>
                              </StyledDropdownMenuItem>
                            </StyledDropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    )
                  }

                  const task = tasksState.find(t => t.id === row.taskId)
                  if (!task) return null

                  return (
                    <div
                      key={row.key}
                      data-row-key={row.key}
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.key, el)
                        else rowRefs.current.delete(row.key)
                      }}
                      onClick={() => { if (!isDraggingRef.current) setSelectedTaskId(task.id) }}
                      className={cn(
                        'planner-sortable-item w-full rounded-[8px] px-3 py-2 text-left select-none',
                        selectedTaskId === task.id
                          ? 'planner-sortable-item--selected bg-background'
                          : 'bg-background shadow-none'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {task.state === 'done' ? (
                          <CheckCircle2 className={cn('h-4 w-4', stateStyles[task.state])} />
                        ) : (
                          <Circle className={cn('h-4 w-4', stateStyles[task.state])} />
                        )}
                        <span className={cn('min-w-0 flex-1 truncate text-sm', task.state === 'done' && 'line-through text-foreground/45')}>
                          {task.title}
                        </span>
                        <span className="text-[11px] text-foreground/45">{task.due}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex-1 min-h-12" aria-hidden="true" />
            </div>
          </ScrollArea>
      </section>

      <aside className="bg-foreground-2 shadow-middle rounded-[10px] overflow-hidden flex-1 min-w-0 flex flex-col">
          {!selectedTask ? (
            <div className="p-5 text-sm text-foreground/50">Select a task to inspect details.</div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="w-full max-w-[720px] mx-auto px-6 pt-8 pb-5">
                {/* Editable title */}
                <div
                  key={selectedTask.id + '-title'}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => updateTaskTitle(selectedTask.id, e.currentTarget.textContent ?? '')}
                  className="text-xl font-bold leading-snug outline-none mb-5"
                >
                  {selectedTask.title}
                </div>

                {/* Metadata badges under title */}
                <div className="flex items-center gap-2 flex-wrap mb-5">
                  <MetadataBadge
                    interactive={false}
                    icon={selectedTask.state === 'done'
                      ? <CheckCircle2 className={cn('h-3.5 w-3.5', stateStyles[selectedTask.state])} />
                      : <Circle className={cn('h-3.5 w-3.5', stateStyles[selectedTask.state])} />}
                    label={stateLabels[selectedTask.state]}
                  />

                  <MetadataBadge
                    interactive={false}
                    icon={<CalendarDays className="h-3.5 w-3.5 text-foreground/55" />}
                    label="Due"
                    value={selectedTask.due}
                  />

                  {selectedHeading && (
                    <MetadataBadge
                      interactive={false}
                      label="Section"
                      value={selectedHeading.title}
                    />
                  )}

                  <MetadataBadge
                    interactive={false}
                    icon={<Link2 className="h-3.5 w-3.5 text-foreground/55" />}
                    label="Sessions"
                    value={String(selectedLinks.length)}
                  />
                </div>

                {/* Editable notes */}
                <TiptapMarkdownEditor
                  key={selectedTask.id + '-notes'}
                  content={selectedTask.notes}
                  onUpdate={(md) => updateTaskNotes(selectedTask.id, md)}
                  placeholder="Add notes..."
                  markdownEngine="official"
                  className="text-sm leading-relaxed text-foreground/75"
                />

                {/* Separator */}
                <div className="border-t border-border/60 mt-5 mb-1" />

                {/* Attached Sessions */}
                <div className="mb-1 text-sm font-semibold">Attached Sessions</div>
                <div className="space-y-2 mt-3">
                  {selectedLinks.length === 0 ? (
                    <div className="text-xs text-foreground/40">No sessions linked.</div>
                  ) : (
                    selectedLinks.map(link => {
                      const snap = snapshots.find(s => s.id === link.snapshotId)
                      if (!snap) return null
                      const meta = syncMeta[link.syncState]
                      const Icon = meta.icon
                      return (
                        <div key={link.id} className="rounded-lg border border-border/60 p-2.5 bg-foreground/[0.01]">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-1.5">
                              <Link2 className="h-3.5 w-3.5 text-foreground/45" />
                              <span className="truncate text-xs font-medium">{snap.title}</span>
                            </div>
                            <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]', meta.cls)}>
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          </div>
                          <p className="text-[11px] text-foreground/60 leading-relaxed">{snap.summary}</p>
                          <div className="mt-1 text-[10px] text-foreground/45">Updated {snap.lastUpdated}</div>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Separator */}
                <div className="border-t border-border/60 my-5" />

                {/* Activity */}
                <div className="mb-3 text-sm font-semibold">Activity</div>
                <div className="space-y-3">
                  {selectedEvents.map(ev => (
                    <div key={ev.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 h-5 w-5 rounded-full bg-foreground/8 flex items-center justify-center shrink-0">
                        <History className="h-3 w-3 text-foreground/45" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground/75">{ev.payloadSummary}</div>
                        <div className="mt-0.5 text-[11px] text-foreground/40">
                          {ev.actor} · {ev.at}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ScrollArea>
          )}
      </aside>

      {/* Sidebar resize handle (absolute) */}
      <div
        ref={sidebarHandleRef}
        onMouseDown={(e) => { e.preventDefault(); setIsResizing('sidebar') }}
        onMouseMove={(e) => {
          if (sidebarHandleRef.current) {
            const rect = sidebarHandleRef.current.getBoundingClientRect()
            setSidebarHandleY(e.clientY - rect.top)
          }
        }}
        onMouseLeave={() => { if (isResizing !== 'sidebar') setSidebarHandleY(null) }}
        className="absolute top-0 h-full cursor-col-resize z-10 flex justify-center"
        style={{
          width: PANEL_SASH_HIT_WIDTH,
          left: sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className="h-full"
          style={{
            width: PANEL_SASH_LINE_WIDTH,
            ...getResizeGradientStyle(sidebarHandleY, sidebarHandleRef.current?.clientHeight ?? null),
          }}
        />
      </div>

      {/* Navigator resize handle (absolute) */}
      <div
        ref={navigatorHandleRef}
        onMouseDown={(e) => { e.preventDefault(); setIsResizing('navigator') }}
        onMouseMove={(e) => {
          if (navigatorHandleRef.current) {
            const rect = navigatorHandleRef.current.getBoundingClientRect()
            setNavigatorHandleY(e.clientY - rect.top)
          }
        }}
        onMouseLeave={() => { if (isResizing !== 'navigator') setNavigatorHandleY(null) }}
        className="absolute top-0 h-full cursor-col-resize z-10 flex justify-center"
        style={{
          width: PANEL_SASH_HIT_WIDTH,
          left: sidebarWidth + PANEL_GAP + navigatorWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className="h-full"
          style={{
            width: PANEL_SASH_LINE_WIDTH,
            ...getResizeGradientStyle(navigatorHandleY, navigatorHandleRef.current?.clientHeight ?? null),
          }}
        />
      </div>
    </div>
  )
}

function PlannerSyncStatePalette() {
  return (
    <div className="w-[820px] rounded-[14px] border border-border bg-background p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <CalendarDays className="h-4 w-4 text-foreground/60" />
        Sync States (task_session_links_local)
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {(Object.keys(syncMeta) as SyncState[]).map((state) => {
          const meta = syncMeta[state]
          const Icon = meta.icon
          return (
            <div key={state} className="rounded-[10px] border border-border/60 bg-foreground/[0.015] p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                <Icon className={cn('h-4 w-4', meta.cls.split(' ')[0])} />
                {meta.label}
              </div>
              <div className="text-xs text-foreground/60">
                Snapshot card always visible; live session resolution is optional enhancement.
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const plannerComponents: ComponentEntry[] = [
  {
    id: 'planner-things-board',
    name: 'Planner Board',
    category: 'Planner',
    description: 'Planner surface with @dnd-kit/dom sortable behavior matching the vertical sample path.',
    component: PlannerBoard,
    layout: 'full',
    props: [],
  },
  {
    id: 'planner-sync-palette',
    name: 'Planner Sync Palette',
    category: 'Planner',
    description: 'Visual language for task_session_links_local sync states.',
    component: PlannerSyncStatePalette,
    props: [],
  },
]
