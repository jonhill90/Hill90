import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock lucide-react
vi.mock('lucide-react', () => ({
  X: (props: any) => <span data-testid="icon-x" {...props} />,
  Plus: (props: any) => <span data-testid="icon-plus" {...props} />,
  UserMinus: (props: any) => <span data-testid="icon-user-minus" {...props} />,
}))

import ParticipantPanel from '@/app/chat/ParticipantPanel'
import type { ChatAgent } from '@/app/chat/ChatLayout'

const CURRENT_AGENTS: ChatAgent[] = [
  { id: 'a1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
  { id: 'a2', agent_id: 'writer-bot', name: 'WriterBot', status: 'running' },
]

const ALL_AGENTS = [
  ...CURRENT_AGENTS,
  { id: 'a3', agent_id: 'review-bot', name: 'ReviewBot', status: 'running' },
  { id: 'a4', agent_id: 'stopped-bot', name: 'StoppedBot', status: 'stopped' },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('ParticipantPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    // Default: GET /api/agents returns all agents
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (url === '/api/agents' && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => ALL_AGENTS }
      }
      if (typeof url === 'string' && url.includes('/participants') && opts?.method === 'PUT') {
        return { ok: true, json: async () => ({ participants: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) }
    })
  })

  afterEach(() => cleanup())

  it('T6: shows current thread agents', async () => {
    render(
      <ParticipantPanel
        threadId="thread-1"
        currentAgents={CURRENT_AGENTS}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('participant-panel')).toBeInTheDocument()

    await waitFor(() => {
      const participants = screen.getAllByTestId('current-participant')
      expect(participants).toHaveLength(2)
    })

    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    expect(screen.getByText('WriterBot')).toBeInTheDocument()
  })

  it('T7: add agent calls PUT /participants', async () => {
    const onUpdated = vi.fn()
    render(
      <ParticipantPanel
        threadId="thread-1"
        currentAgents={CURRENT_AGENTS}
        onUpdated={onUpdated}
        onClose={vi.fn()}
      />
    )

    // Wait for agents to load
    await waitFor(() => {
      expect(screen.getByText('ReviewBot')).toBeInTheDocument()
    })

    // Click add button for ReviewBot
    const addButtons = screen.getAllByTestId('add-agent-button')
    fireEvent.click(addButtons[0])

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/chat/thread-1/participants',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"add"'),
        })
      )
      expect(onUpdated).toHaveBeenCalled()
    })
  })

  it('T8: remove agent requires confirmation', async () => {
    render(
      <ParticipantPanel
        threadId="thread-1"
        currentAgents={CURRENT_AGENTS}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('current-participant')).toHaveLength(2)
    })

    // Click remove icon on first agent
    const removeButtons = screen.getAllByTestId('remove-button')
    fireEvent.click(removeButtons[0])

    // Should show confirmation, not immediately remove
    expect(screen.getByTestId('confirm-remove')).toBeInTheDocument()

    // Click confirm
    fireEvent.click(screen.getByTestId('confirm-remove'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/chat/thread-1/participants',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"remove"'),
        })
      )
    })
  })
})
