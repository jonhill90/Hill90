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
    last_message: {
      content: 'Hello from agent',
      author_type: 'agent',
      created_at: '2026-01-01T01:00:00Z',
      status: 'complete',
    },
    agent: { id: 'agent-1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
  },
  {
    id: 'thread-2',
    type: 'direct',
    title: 'My custom title',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:30:00Z',
    agent: { id: 'agent-2', agent_id: 'writer-bot', name: 'WriterBot', status: 'stopped' },
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
      // ResearchBot may appear in both desktop and mobile sidebar
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

  it('opens new thread dialog on button click', async () => {
    // First fetch returns threads, second fetch (for agents in dialog) returns empty
    let callCount = 0
    mockFetch.mockImplementation(async (url: string) => {
      callCount++
      if (typeof url === 'string' && url.includes('/api/agents')) {
        return { ok: true, json: async () => [] }
      }
      return { ok: true, json: async () => MOCK_THREADS }
    })

    render(<ChatLayout session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getAllByText('+ New').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByText('+ New')[0])

    await waitFor(() => {
      // Dialog opens with a "Start Chat" submit button
      expect(screen.getByText('Start Chat')).toBeInTheDocument()
      // And has agent/message form fields
      expect(screen.getByText('Agent')).toBeInTheDocument()
      expect(screen.getByText('Message')).toBeInTheDocument()
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
      // Should show agent name in header area
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
})
