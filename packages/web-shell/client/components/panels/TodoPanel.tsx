import type { TodoItem } from '../../adapters/types';

interface TodoPanelProps {
  todos: TodoItem[];
  title?: string;
}

const MAX_VISIBLE = 5;

export function TodoPanel({ todos, title = '当前任务' }: TodoPanelProps) {
  if (todos.length === 0) return null;

  // Rotate list so the current in_progress item is first
  const currentIdx = todos.findIndex((t) => t.status === 'in_progress');
  const startIdx =
    currentIdx >= 0
      ? currentIdx
      : todos.findIndex((t) => t.status === 'pending');
  const rotated =
    startIdx > 0
      ? [...todos.slice(startIdx), ...todos.slice(0, startIdx)]
      : todos;

  const visible = rotated.slice(0, MAX_VISIBLE);
  const remaining = rotated.length - MAX_VISIBLE;

  // Map back to original index for numbering
  const originalIndices =
    startIdx > 0
      ? [...Array(todos.length).keys()].map(
          (i) => (i + startIdx) % todos.length,
        )
      : [...Array(todos.length).keys()];

  return (
    <div className="todo-panel">
      <div className="todo-panel-header">
        <span className="todo-panel-title">{title}</span>
      </div>
      <div className="todo-panel-list">
        {visible.map((todo, i) => (
          <div
            key={todo.id || i}
            className={`todo-item todo-item-${todo.status}`}
          >
            <span className="todo-item-num">{originalIndices[i] + 1}.</span>
            <span className="todo-item-icon">
              {todo.status === 'completed'
                ? '●'
                : todo.status === 'in_progress'
                  ? '◐'
                  : '○'}
            </span>
            <span className="todo-item-content">{todo.content}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className="todo-item todo-item-more">
            <span className="todo-item-num"></span>
            <span className="todo-item-content">
              ... 以及其他 {remaining} 个
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
