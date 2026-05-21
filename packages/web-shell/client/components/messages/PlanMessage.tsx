import type { TodoItem } from '../../adapters/types';

interface PlanMessageProps {
  todos: TodoItem[];
}

function markerForStatus(status: TodoItem['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '→';
  return ' ';
}

export function PlanMessage({ todos }: PlanMessageProps) {
  if (todos.length === 0) return null;

  return (
    <div className="plan-message">
      <div className="plan-message-title">Plan</div>
      <div className="plan-message-list">
        {todos.map((todo, index) => (
          <div
            key={todo.id || index}
            className={`plan-message-item plan-message-item-${todo.status}`}
          >
            <span className="plan-message-num">{index + 1}.</span>
            <span className="plan-message-marker">
              {markerForStatus(todo.status)}
            </span>
            <span className="plan-message-content">{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
