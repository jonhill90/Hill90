'use client'

import React, { useState, useEffect, useCallback } from 'react'

interface Task {
  id: string
  agent_id: string
  title: string
  description: string
  status: string
  priority: number
  sort_order: number
  tags: string[]
  created_by: string
  created_at: string
  updated_at: string
}

const COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
] as const

type ColumnId = typeof COLUMNS[number]['id']

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Urgent', color: 'bg-red-900/50 text-red-400 border-red-700' },
  2: { label: 'High', color: 'bg-amber-900/50 text-amber-400 border-amber-700' },
  3: { label: 'Medium', color: 'bg-navy-700/50 text-mountain-300 border-navy-600' },
  4: { label: 'Low', color: 'bg-navy-800/50 text-mountain-500 border-navy-700' },
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface NewTaskForm {
  agent_id: string
  title: string
  description: string
  priority: number
}

export default function TaskBoardClient() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<Array<{ agent_id: string; name: string }>>([])
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [transitioning, setTransitioning] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newTask, setNewTask] = useState<NewTaskForm>({ agent_id: '', title: '', description: '', priority: 3 })
  const [creating, setCreating] = useState(false)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks')
      if (res.ok) {
        const data = await res.json()
        setTasks(Array.isArray(data) ? data : [])
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (res.ok) {
        const data = await res.json()
        setAgents(Array.isArray(data) ? data : [])
      }
    } catch {
      // Non-fatal
    }
  }, [])

  useEffect(() => {
    fetchTasks()
    fetchAgents()
  }, [fetchTasks, fetchAgents])

  const handleTransition = async (taskId: string, newStatus: string) => {
    setTransitioning(taskId)
    try {
      const res = await fetch(`/api/tasks/${taskId}/transition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        const updated = await res.json()
        setTasks(prev => prev.map(t => t.id === taskId ? updated : t))
        if (selectedTask?.id === taskId) setSelectedTask(updated)
      }
    } catch {
      // Non-fatal
    } finally {
      setTransitioning(null)
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTask.agent_id || !newTask.title.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTask),
      })
      if (res.ok) {
        const created = await res.json()
        setTasks(prev => [...prev, created])
        setNewTask({ agent_id: '', title: '', description: '', priority: 3 })
        setShowNewForm(false)
      }
    } catch {
      // Non-fatal
    } finally {
      setCreating(false)
    }
  }

  const tasksByColumn = (columnId: string) =>
    tasks.filter(t => t.status === columnId)

  // Task detail panel
  if (selectedTask) {
    const nextStatuses = COLUMNS.map(c => c.id).filter(s => s !== selectedTask.status)
    return (
      <div>
        <div className="mb-4">
          <button
            onClick={() => setSelectedTask(null)}
            className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
            data-testid="back-to-board"
          >
            Back to board
          </button>
        </div>
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-6" data-testid="task-detail">
          <h2 className="text-xl font-semibold text-white mb-2">{selectedTask.title}</h2>
          <div className="flex items-center gap-2 mb-4">
            <span className={`px-2 py-0.5 text-xs rounded-md border ${PRIORITY_LABELS[selectedTask.priority]?.color || ''}`}>
              {PRIORITY_LABELS[selectedTask.priority]?.label || `P${selectedTask.priority}`}
            </span>
            <span className="text-xs text-mountain-400">{selectedTask.agent_id}</span>
            <span className="text-xs text-mountain-500">Updated {timeAgo(selectedTask.updated_at)}</span>
          </div>
          {selectedTask.description && (
            <p className="text-sm text-mountain-300 mb-4 whitespace-pre-wrap">{selectedTask.description}</p>
          )}
          {selectedTask.tags.length > 0 && (
            <div className="flex gap-1 mb-4">
              {selectedTask.tags.map(tag => (
                <span key={tag} className="px-1.5 py-0.5 text-xs rounded-md border border-navy-600 text-mountain-400">{tag}</span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-mountain-500">Move to:</span>
            {nextStatuses.map(s => (
              <button
                key={s}
                onClick={() => handleTransition(selectedTask.id, s)}
                disabled={transitioning === selectedTask.id}
                className="px-3 py-1 text-xs font-medium rounded-md bg-navy-700 hover:bg-navy-600 text-white transition-colors cursor-pointer disabled:opacity-50"
                data-testid={`transition-${s}`}
              >
                {COLUMNS.find(c => c.id === s)?.label || s}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Tasks</h1>
        <button
          onClick={() => setShowNewForm(!showNewForm)}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          data-testid="new-task-button"
        >
          + New Task
        </button>
      </div>

      {/* New task form */}
      {showNewForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6" data-testid="new-task-form">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Agent</label>
              <select
                value={newTask.agent_id}
                onChange={e => setNewTask(prev => ({ ...prev, agent_id: e.target.value }))}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                required
              >
                <option value="">Select agent...</option>
                {agents.map(a => (
                  <option key={a.agent_id} value={a.agent_id}>{a.name || a.agent_id}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Priority</label>
              <select
                value={newTask.priority}
                onChange={e => setNewTask(prev => ({ ...prev, priority: Number(e.target.value) }))}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
              >
                <option value={1}>Urgent</option>
                <option value={2}>High</option>
                <option value={3}>Medium</option>
                <option value={4}>Low</option>
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs text-mountain-400 mb-1">Title</label>
            <input
              type="text"
              value={newTask.title}
              onChange={e => setNewTask(prev => ({ ...prev, title: e.target.value }))}
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
              placeholder="Task title..."
              required
            />
          </div>
          <div className="mb-4">
            <label className="block text-xs text-mountain-400 mb-1">Description</label>
            <textarea
              value={newTask.description}
              onChange={e => setNewTask(prev => ({ ...prev, description: e.target.value }))}
              rows={2}
              className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none resize-y"
              placeholder="Optional description..."
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Task'}
            </button>
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              className="px-4 py-2 text-sm font-medium rounded-md text-mountain-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Board */}
      {loading ? (
        <div className="flex items-center justify-center py-12" data-testid="loading">
          <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-3" data-testid="board">
          {COLUMNS.map(col => {
            const colTasks = tasksByColumn(col.id)
            return (
              <div key={col.id} className="min-h-[200px]" data-testid={`column-${col.id}`}>
                <div className="flex items-center justify-between mb-3 px-1">
                  <h3 className="text-sm font-medium text-mountain-400">{col.label}</h3>
                  <span className="text-xs text-mountain-500">{colTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {colTasks.map(task => (
                    <button
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className="w-full text-left rounded-lg border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
                      data-testid="task-card"
                    >
                      <p className="text-sm font-medium text-white line-clamp-2 mb-1">{task.title}</p>
                      <div className="flex items-center gap-1.5">
                        <span className={`px-1.5 py-0.5 text-[10px] rounded border ${PRIORITY_LABELS[task.priority]?.color || ''}`}>
                          {PRIORITY_LABELS[task.priority]?.label || `P${task.priority}`}
                        </span>
                        <span className="text-[10px] text-mountain-500 truncate">{task.agent_id}</span>
                      </div>
                      <p className="text-[10px] text-mountain-500 mt-1">{timeAgo(task.updated_at)}</p>
                    </button>
                  ))}
                  {colTasks.length === 0 && (
                    <p className="text-xs text-mountain-500 text-center py-4" data-testid="column-empty">
                      No tasks
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
