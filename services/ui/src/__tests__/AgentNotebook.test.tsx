import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentNotebook from '@/app/agents/[id]/AgentNotebook'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

const MOCK_ENTRIES = [
  { id: 'n1', agent_id: 'bot-1', path: 'notebook/scratch.md', title: 'Scratch Pad', entry_type: 'notebook', tags: [], status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
  { id: 'n2', agent_id: 'bot-1', path: 'notebook/draft-plan.md', title: 'Draft Plan', entry_type: 'notebook', tags: ['wip'], status: 'active', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-04T00:00:00Z' },
  { id: 'n3', agent_id: 'bot-1', path: 'notebook/observations.md', title: 'Observations', entry_type: 'notebook', tags: [], status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('AgentNotebook', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/knowledge/entries?agent_id=') && url.includes('type=notebook')) {
        return { ok: true, json: async () => MOCK_ENTRIES }
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/entries/')) {
        return { ok: true, json: async () => ({ content: '# Scratch Pad\n\nSome **bold** notes here.' }) }
      }
      return { ok: false, json: async () => ({}) }
    })
  })

  afterEach(() => cleanup())

  it('T1: renders notebook entry list', async () => {
    render(<AgentNotebook agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('entry-list')).toBeInTheDocument()
    })

    const items = screen.getAllByTestId('entry-item')
    expect(items).toHaveLength(3)
    expect(screen.getByText('Scratch Pad')).toBeInTheDocument()
    expect(screen.getByText('Draft Plan')).toBeInTheDocument()
    expect(screen.getByText('Observations')).toBeInTheDocument()
  })

  it('T2: shows empty state when no entries', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => [],
    }))

    render(<AgentNotebook agentId="bot-empty" />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    })

    expect(screen.getByText(/No notebook entries/)).toBeInTheDocument()
  })

  it('T3: click entry shows detail with markdown rendering', async () => {
    render(<AgentNotebook agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('entry-item')[0])

    await waitFor(() => {
      expect(screen.getByTestId('entry-content')).toBeInTheDocument()
    })

    expect(screen.getByTestId('markdown')).toBeInTheDocument()
    expect(screen.getByTestId('back-to-list')).toBeInTheDocument()
  })

  it('T4: back button returns to list', async () => {
    render(<AgentNotebook agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('entry-item')[0])

    await waitFor(() => {
      expect(screen.getByTestId('back-to-list')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('back-to-list'))

    await waitFor(() => {
      expect(screen.getByTestId('entry-list')).toBeInTheDocument()
    })
  })

  it('T5: entries sorted by updated_at descending', async () => {
    render(<AgentNotebook agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(3)
    })

    const items = screen.getAllByTestId('entry-item')
    // Draft Plan (2026-01-04) should be first, then Scratch Pad (2026-01-03), then Observations (2026-01-01)
    expect(items[0]).toHaveTextContent('Draft Plan')
    expect(items[1]).toHaveTextContent('Scratch Pad')
    expect(items[2]).toHaveTextContent('Observations')
  })

  it('T6: shows loading state', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})) // Never resolves

    render(<AgentNotebook agentId="bot-1" />)

    expect(screen.getByTestId('loading')).toBeInTheDocument()
  })
})
