import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import NewThreadDialog from '@/app/chat/NewThreadDialog'

const MOCK_AGENTS = [
  { id: 'a1', agent_id: 'bot-1', name: 'Bot One', status: 'running' },
  { id: 'a2', agent_id: 'bot-2', name: 'Bot Two', status: 'running' },
  { id: 'a3', agent_id: 'bot-3', name: 'Bot Three', status: 'running' },
]

describe('NewThreadDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/agents')) {
        return { ok: true, json: async () => MOCK_AGENTS }
      }
      return { ok: true, json: async () => ({ thread: { id: 'new-thread' } }) }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders dialog with agent picker', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-picker')).toBeInTheDocument()
      expect(screen.getByText('Bot One')).toBeInTheDocument()
      expect(screen.getByText('Bot Two')).toBeInTheDocument()
      expect(screen.getByText('Bot Three')).toBeInTheDocument()
    })
  })

  it('shows "Start Chat" for single agent selection', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    // Select one agent
    fireEvent.click(screen.getByText('Bot One'))

    expect(screen.getByText('Start Chat')).toBeInTheDocument()
  })

  it('shows "Start Group Chat" for multi-agent selection', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    // Select two agents → group mode
    fireEvent.click(screen.getByText('Bot One'))
    fireEvent.click(screen.getByText('Bot Two'))

    expect(screen.getByText('Start Group Chat')).toBeInTheDocument()
  })

  it('shows "(group chat)" label when multiple agents selected', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Bot One'))
    fireEvent.click(screen.getByText('Bot Two'))

    expect(screen.getByText('(group chat)')).toBeInTheDocument()
  })

  it('sends agent_id for direct thread creation', async () => {
    const onCreated = vi.fn()
    render(<NewThreadDialog onClose={vi.fn()} onCreated={onCreated} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Bot One'))
    fireEvent.change(screen.getByPlaceholderText('Type your first message...'), {
      target: { value: 'Hello' },
    })
    fireEvent.click(screen.getByText('Start Chat'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('/api/chat') && c[1]?.method === 'POST'
      )
      expect(postCall).toBeTruthy()
      const body = JSON.parse(postCall![1].body)
      expect(body.agent_id).toBe('a1')
      expect(body.message).toBe('Hello')
      expect(body.agent_ids).toBeUndefined()
    })
  })

  it('sends agent_ids for group thread creation', async () => {
    const onCreated = vi.fn()
    render(<NewThreadDialog onClose={vi.fn()} onCreated={onCreated} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Bot One'))
    fireEvent.click(screen.getByText('Bot Two'))
    fireEvent.change(screen.getByPlaceholderText('Type your first message...'), {
      target: { value: 'Hello group' },
    })
    fireEvent.click(screen.getByText('Start Group Chat'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('/api/chat') && c[1]?.method === 'POST'
      )
      expect(postCall).toBeTruthy()
      const body = JSON.parse(postCall![1].body)
      expect(body.agent_ids).toEqual(expect.arrayContaining(['a1', 'a2']))
      expect(body.message).toBe('Hello group')
      expect(body.agent_id).toBeUndefined()
    })
  })

  it('calls onClose when Cancel clicked', async () => {
    const onClose = vi.fn()
    render(<NewThreadDialog onClose={onClose} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables submit when no agent selected or no message', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Bot One')).toBeInTheDocument()
    })

    // No selection — button disabled
    const submitBtn = screen.getByText('Start Chat')
    expect(submitBtn).toBeDisabled()

    // Select agent but no message — still disabled
    fireEvent.click(screen.getByText('Bot One'))
    expect(submitBtn).toBeDisabled()
  })
})
