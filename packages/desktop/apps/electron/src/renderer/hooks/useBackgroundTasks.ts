/**
 * useBackgroundTasks - Hook for managing active background tasks
 *
 * Tracks background agents and shells per session.
 * Updated via event handlers for task_backgrounded, shell_backgrounded, task_progress.
 */

import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'

export interface UseBackgroundTasksOptions {
  /** Session ID to track tasks for */
  sessionId: string
}

export interface UseBackgroundTasksResult {
  /** Active background tasks for this session */
  tasks: BackgroundTask[]
  /** Add a new background task */
  addTask: (task: Omit<BackgroundTask, 'elapsedSeconds'>) => void
  /** Update elapsed time for a task */
  updateTaskProgress: (toolUseId: string, elapsedSeconds: number) => void
  /** Remove a task (when completed or killed) */
  removeTask: (toolUseId: string) => void
  /** Kill a task (sends kill request via IPC) */
  killTask: (taskId: string, type: 'agent' | 'shell') => Promise<void>
}

/**
 * Hook for managing background tasks in a session
 */
export function useBackgroundTasks({ sessionId }: UseBackgroundTasksOptions): UseBackgroundTasksResult {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))

  const addTask = useCallback((task: Omit<BackgroundTask, 'elapsedSeconds'>) => {
    setTasks(prev => {
      // Check if task already exists (prevent duplicates)
      if (prev.some(t => t.toolUseId === task.toolUseId)) {
        return prev
      }
      // Add new task with 0 elapsed seconds
      return [...prev, { ...task, elapsedSeconds: 0 }]
    })
  }, [setTasks])

  const updateTaskProgress = useCallback((toolUseId: string, elapsedSeconds: number) => {
    setTasks(prev => prev.map(t =>
      t.toolUseId === toolUseId
        ? { ...t, elapsedSeconds }
        : t
    ))
  }, [setTasks])

  const removeTask = useCallback((toolUseId: string) => {
    setTasks(prev => prev.filter(t => t.toolUseId !== toolUseId))
  }, [setTasks])

  const killTask = useCallback(async (taskId: string, type: 'agent' | 'shell') => {
    // Find the task to get its toolUseId
    const task = tasks.find(t => t.id === taskId)

    if (type === 'shell') {
      // Use KillShell IPC for shells
      try {
        await window.electronAPI.killShell(sessionId, taskId)
      } catch {
        // Shell may already be gone - that's OK, still remove from UI
      }
    } else {
      // For agents, we don't have a direct kill mechanism yet
      // The model would need to use TaskOutput to check status
      console.warn('Killing agent tasks not yet implemented')
    }

    // Always remove from UI after kill attempt
    if (task) {
      setTasks(prev => prev.filter(t => t.id !== taskId))
    }
  }, [sessionId, tasks, setTasks])

  return {
    tasks,
    addTask,
    updateTaskProgress,
    removeTask,
    killTask,
  }
}
