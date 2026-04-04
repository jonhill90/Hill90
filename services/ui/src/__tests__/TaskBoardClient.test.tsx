import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import TaskBoardClient from '@/app/tasks/TaskBoardClient'

const MOCK_TASKS = [
  { id: 't1', agent_id: 'bot-1', title: 'Deploy API', description: 'Deploy the API service', status: 'backlog', priority: 2, sort_order: 0, tags: ['ops'], created_by: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 't2', agent_id: 'bot-1', title: 'Fix auth bug', description: '', status: 'in_progress', priority: 1, sort_order: 0, tags: [], created_by: 'user-1', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
  { id: 't3', agent_id: 'bot-2', title: 'Write tests', description: '', status: 'done', priority: 3, sort_order: 0, tags: [], created_by: 'bot-2', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
]

const MOCK_AGENTS = [
  { agent_id: 'bot-1', name: 'Bot One' },
  { agent_id: 'bot-2', name: 'Bot Two' },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('TaskBoardClient', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/tasks' && (!opts || opts.method === undefined || opts.method === 'GET')) {
        return { ok: true, json: async () => MOCK_TASKS }
      }
      if (typeof url === 'string' && url === '/api/agents') {
        return { ok: true, json: async () => MOCK_AGENTS }
      }
      if (typeof url === 'string' && url.includes('/transition')) {
        const body = JSON.parse(opts?.body as string)
        const taskId = url.split('/tasks/')[1].split('/')[0]
        const task = MOCK_TASKS.find(t => t.id === taskId)
        return { ok: true, json: async () => ({ ...task, status: body.status }) }
      }
      return { ok: false, json: async () => ({}) }
    })
  })

  afterEach(() => cleanup())

  it('T1: renders all 5 board columns', async () => {
    render(<TaskBoardClient />)

    await waitFor(() => {
      expect(screen.getByTestId('board')).toBeInTheDocument()
    })

    expect(screen.getByTestId('column-backlog')).toBeInTheDocument()
    expect(screen.getByTestId('column-todo')).toBeInTheDocument()
    expect(screen.getByTestId('column-in_progress')).toBeInTheDocument()
    expect(screen.getByTestId('column-review')).toBeInTheDocument()
    expect(screen.getByTestId('column-done')).toBeInTheDocument()
  })

  it('T2: tasks appear in correct columns', async () => {
    render(<TaskBoardClient />)

    await waitFor(() => {
      expect(screen.getAllByTestId('task-card')).toHaveLength(3)
    })

    // Deploy API should be in backlog column
    const backlog = screen.getByTestId('column-backlog')
    expect(backlog).toHaveTextContent('Deploy API')

    // Fix auth bug should be in in_progress column
    const inProgress = screen.getByTestId('column-in_progress')
    expect(inProgress).toHaveTextContent('Fix auth bug')

    // Write tests should be in done column
    const done = screen.getByTestId('column-done')
    expect(done).toHaveTextContent('Write tests')
  })

  it('T3: empty columns show empty state', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url === '/api/tasks') {
        return { ok: true, json: async () => [] }
      }
      if (typeof url === 'string' && url === '/api/agents') {
        return { ok: true, json: async () => [] }
      }
      return { ok: false, json: async () => ({}) }
    })

    render(<TaskBoardClient />)

    await waitFor(() => {
      expect(screen.getByTestId('board')).toBeInTheDocument()
    })

    const emptyStates = screen.getAllByTestId('column-empty')
    expect(emptyStates.length).toBe(5)
  })

  it('T4: click task shows detail panel', async () => {
    render(<TaskBoardClient />)

    await waitFor(() => {
      expect(screen.getAllByTestId('task-card')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('task-card')[0])

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    })

    expect(screen.getByText('Deploy API')).toBeInTheDocument()
    expect(screen.getByTestId('back-to-board')).toBeInTheDocument()
  })

  it('T5: click-to-transition calls API and updates task', async () => {
    render(<TaskBoardClient />)

    await waitFor(() => {
      expect(screen.getAllByTestId('task-card')).toHaveLength(3)
    })

    // Click "Deploy API" (backlog task)
    fireEvent.click(screen.getAllByTestId('task-card')[0])

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    })

    // Click "To Do" transition button
    const todoButton = screen.getByTestId('transition-todo')
    fireEvent.click(todoButton)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/tasks/t1/transition',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'todo' }),
        }),
      )
    })
  })

  it('T6: shows loading state', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}))

    render(<TaskBoardClient />)

    expect(screen.getByTestId('loading')).toBeInTheDocument()
  })
})
