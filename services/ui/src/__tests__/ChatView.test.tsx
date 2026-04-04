import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockRouter = { push: vi.fn(), back: vi.fn(), refresh: vi.fn() }

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('lucide-react', () => ({
  ArrowLeft: (props: any) => <span data-testid="icon-arrow-left" {...props} />,
  Send: (props: any) => <span data-testid="icon-send" {...props} />,
  Terminal: (props: any) => <span data-testid="icon-terminal" {...props} />,
}))

vi.mock('@/app/chat/ChatMessage', () => ({
  default: ({ message }: any) => <div data-testid="chat-message">{message.content}</div>,
}))

vi.mock('@/app/chat/AgentStatusBar', () => ({
  default: () => <div data-testid="agent-status-bar" />,
}))

vi.mock('@/app/chat/CancelButton', () => ({
  default: () => <div data-testid="cancel-button" />,
}))

vi.mock('@/app/chat/SessionPane', () => ({
  default: () => <div data-testid="session-pane" />,
}))

import ChatView from '@/app/chat/ChatView'
import type { ChatThread } from '@/app/chat/ChatLayout'

const mockSession = {
  user: { id: 'user-1', name: 'Test', roles: ['user'] },
  expires: '2026-12-31',
}

const mockThread: ChatThread = {
  id: 'thread-1',
  type: 'direct',
  title: 'Test Chat',
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  agent: { id: 'agent-1', agent_id: 'bot-1', name: 'TestBot', status: 'running' },
}

// Mock EventSource
class MockEventSource {
  url: string
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  listeners: Record<string, ((e: any) => void)[]> = {}
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(type: string, cb: (e: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(cb)
  }
  removeEventListener() {}
  close() {}
}

describe('ChatView', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.instances = []
    ;(globalThis as any).EventSource = MockEventSource
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    delete (globalThis as any).EventSource
  })

  const defaultProps = {
    threadId: 'thread-1',
    session: mockSession as any,
    thread: mockThread,
    onBack: vi.fn(),
    onThreadUpdated: vi.fn(),
  }

  it('renders message input', () => {
    render(<ChatView {...defaultProps} />)
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
    expect(screen.getByTestId('icon-send')).toBeInTheDocument()
  })

  it('renders back button', () => {
    render(<ChatView {...defaultProps} />)
    expect(screen.getByTestId('icon-arrow-left')).toBeInTheDocument()
  })

  it('sends message on form submit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    })
    globalThis.fetch = mockFetch

    render(<ChatView {...defaultProps} />)
    const input = screen.getByPlaceholderText('Type a message...')
    fireEvent.change(input, { target: { value: 'Hello agent' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/chat/thread-1/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'Hello agent' }),
        })
      )
    })
  })

  it('shows error when send fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    })
    globalThis.fetch = mockFetch

    render(<ChatView {...defaultProps} />)
    const input = screen.getByPlaceholderText('Type a message...')
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  it('connects to SSE stream on mount', () => {
    render(<ChatView {...defaultProps} />)
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toBe('/api/chat/thread-1/stream')
  })
})
