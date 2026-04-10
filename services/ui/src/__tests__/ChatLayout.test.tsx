import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: any }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock next/navigation
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/chat',
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock EventSource
class MockEventSource {
  url: string
  listeners: Record<string, ((e: any) => void)[]> = {}
  close = vi.fn()
  onerror: ((e: any) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  addEventListener(event: string, cb: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(cb)
  }

  removeEventListener(event: string, cb: (e: any) => void) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(l => l !== cb)
    }
  }

  emit(event: string, data: any) {
    for (const cb of this.listeners[event] || []) {
      cb(data)
    }
  }
}

vi.stubGlobal('EventSource', MockEventSource)

import ChatLayout from '@/app/chat/ChatLayout'

const MOCK_SESSION = {
  user: { id: 'user-1', name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const MOCK_THREADS = [
  {
    id: 'thread-1',
    type: 'direct',
    title: null,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T01:00:00Z',
    last_message: 'Hello from agent',
    last_author_type: 'agent',
    agent_count: 1,
    agents: [{ id: 'agent-1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' }],
    agent: { id: 'agent-1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
  },
  {
    id: 'thread-2',
    type: 'direct',
    title: 'My custom title',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:30:00Z',
    last_message: null,
    agent_count: 1,
    agents: [{ id: 'agent-2', agent_id: 'writer-bot', name: 'WriterBot', status: 'stopped' }],
    agent: { id: 'agent-2', agent_id: 'writer-bot', name: 'WriterBot', status: 'stopped' },
  },
  {
    id: 'thread-3',
    type: 'group',
    title: 'Research Group',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T02:00:00Z',
    last_message: 'Latest update',
    agent_count: 3,
    agents: [
      { id: 'agent-1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
      { id: 'agent-3', agent_id: 'analyst-bot', name: 'AnalystBot', status: 'running' },
      { id: 'agent-4', agent_id: 'summary-bot', name: 'SummaryBot', status: 'stopped' },
    ],
  },
]

describe('ChatLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_THREADS,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders thread list with thread names', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThan(0)
      expect(screen.getAllByText('My custom title').length).toBeGreaterThan(0)
    })
  })

  it('shows last message preview in thread list', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('Hello from agent').length).toBeGreaterThan(0)
    })
  })

  it('shows group thread with group icon', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('Research Group').length).toBeGreaterThan(0)
      expect(screen.getAllByTestId('group-icon').length).toBeGreaterThan(0)
    })
  })

  it('shows agent names under group thread title', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('agent-names').length).toBeGreaterThan(0)
      const agentNameEl = screen.getAllByTestId('agent-names')[0]
      expect(agentNameEl.textContent).toContain('ResearchBot')
      expect(agentNameEl.textContent).toContain('AnalystBot')
    })
  })

  it('shows empty state when no threads', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText(/No conversations yet/).length).toBeGreaterThan(0)
    })
  })

  it('shows "Select a thread" prompt when no thread is active (desktop)', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText(/Select a thread or start a new conversation/)).toBeInTheDocument()
    })
  })

  it('renders new thread button', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('+ New').length).toBeGreaterThan(0)
    })
  })

  it('opens new thread dialog with agent picker on button click', async () => {
    const mockAgents = [
      { id: 'agent-1', agent_id: 'bot-1', name: 'Bot One', status: 'running' },
      { id: 'agent-2', agent_id: 'bot-2', name: 'Bot Two', status: 'running' },
    ]
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/agents')) {
        return { ok: true, json: async () => mockAgents }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('+ New').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByText('+ New')[0])

    await waitFor(() => {
      expect(screen.getByText('Start Chat')).toBeInTheDocument()
      expect(screen.getByTestId('agent-picker')).toBeInTheDocument()
      expect(screen.getByText('Bot One')).toBeInTheDocument()
      expect(screen.getByText('Bot Two')).toBeInTheDocument()
    })
  })
})

describe('Thread Deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_THREADS,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows delete button on each thread', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
      expect(screen.getAllByTestId('delete-thread-thread-2').length).toBeGreaterThan(0)
    })
  })

  it('shows confirmation dialog when delete button is clicked', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-delete-thread-1').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Delete this thread?').length).toBeGreaterThan(0)
    })
  })

  it('dismisses confirmation dialog on cancel', async () => {
    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-cancel-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-cancel-thread-1')[0])

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-delete-thread-1')).not.toBeInTheDocument()
    })
  })

  it('calls DELETE endpoint on confirm and refreshes thread list', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({ deleted: true }) }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-yes-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-yes-thread-1')[0])

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/chat/thread-1', { method: 'DELETE' })
    })
  })

  it('navigates to /chat when deleting the active thread', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({ deleted: true }) }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} activeThreadId="thread-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-yes-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-yes-thread-1')[0])

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/chat')
    })
  })

  it('shows error toast when delete fails', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        return { ok: false, json: async () => ({ error: 'Thread not found' }) }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-yes-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-yes-thread-1')[0])

    await waitFor(() => {
      expect(screen.getByTestId('error-toast')).toBeInTheDocument()
      expect(screen.getByText('Thread not found')).toBeInTheDocument()
    })
  })

  it('shows error toast on network failure', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        throw new Error('Network error')
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-yes-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-yes-thread-1')[0])

    await waitFor(() => {
      expect(screen.getByTestId('error-toast')).toBeInTheDocument()
      expect(screen.getByText('Failed to delete thread')).toBeInTheDocument()
    })
  })

  it('dismisses error toast when close button is clicked', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        return { ok: false, json: async () => ({ error: 'Thread not found' }) }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('delete-thread-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('delete-thread-thread-1')[0])

    await waitFor(() => {
      expect(screen.getAllByTestId('confirm-yes-thread-1').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('confirm-yes-thread-1')[0])

    await waitFor(() => {
      expect(screen.getByTestId('error-toast')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Dismiss error'))

    await waitFor(() => {
      expect(screen.queryByTestId('error-toast')).not.toBeInTheDocument()
    })
  })
})

describe('ChatView via ChatLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_THREADS,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders message pane when thread is active', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-1"
      />
    )

    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThan(0)
    })
  })

  it('shows send input and button', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-1"
      />
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
    })
  })

  it('shows session toggle button', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-1"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('session-tabs')).toBeInTheDocument()
    })
  })

  it('shows group-specific placeholder in group thread', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-3"
      />
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Message all agents/)).toBeInTheDocument()
    })
  })

  it('shows agent status bar in group thread header', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-3"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('agent-status-bar')).toBeInTheDocument()
    })
  })

  it('shows Group badge in group thread header', async () => {
    render(
      <ChatLayout
        session={MOCK_SESSION as any}
        activeThreadId="thread-3"
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Group')).toBeInTheDocument()
    })
  })
})
