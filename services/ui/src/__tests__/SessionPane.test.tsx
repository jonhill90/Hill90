import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock EventCard to avoid importing the full agent EventCard tree
vi.mock('@/app/agents/[id]/EventCard', () => ({
  default: ({ event }: { event: any }) => (
    <div data-testid={`event-${event.id}`}>{event.tool}: {event.summary}</div>
  ),
}))

// Mock EventSource
let latestES: any = null
class MockEventSource {
  url: string
  listeners: Record<string, ((e: any) => void)[]> = {}
  close = vi.fn()
  onerror: ((e: any) => void) | null = null
  onmessage: ((e: any) => void) | null = null

  constructor(url: string) {
    this.url = url
    latestES = this
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

import SessionPane from '@/app/chat/SessionPane'

describe('SessionPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestES = null
  })

  afterEach(() => {
    cleanup()
  })

  it('renders session pane with filter buttons', () => {
    render(<SessionPane threadId="thread-1" />)

    expect(screen.getByTestId('session-pane')).toBeInTheDocument()
    expect(screen.getByText('Live Session')).toBeInTheDocument()
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Runtime')).toBeInTheDocument()
    expect(screen.getByText('Inference')).toBeInTheDocument()
  })

  it('connects EventSource to thread events endpoint', () => {
    render(<SessionPane threadId="thread-42" />)

    expect(latestES).not.toBeNull()
    expect(latestES.url).toBe('/api/chat/thread-42/events?follow=true&tail=20')
  })

  it('shows "Waiting for events..." when empty', () => {
    render(<SessionPane threadId="thread-1" />)
    expect(screen.getByTestId('no-events')).toHaveTextContent('Waiting for events...')
  })

  it('renders events received via SSE', () => {
    render(<SessionPane threadId="thread-1" />)

    const event = {
      id: 'evt-1',
      tool: 'shell',
      summary: 'ls output',
      timestamp: '2026-01-01T00:00:00Z',
    }

    act(() => {
      latestES.onmessage?.({ data: JSON.stringify(event) })
    })

    expect(screen.getByTestId('event-evt-1')).toBeInTheDocument()
    expect(screen.getByText('shell: ls output')).toBeInTheDocument()
  })

  it('filters events by tool type', () => {
    render(<SessionPane threadId="thread-1" />)

    const shellEvt = { id: 'e1', tool: 'shell', summary: 'cmd', timestamp: '2026-01-01T00:00:00Z' }
    const runtimeEvt = { id: 'e2', tool: 'runtime', summary: 'start', timestamp: '2026-01-01T00:00:01Z' }

    act(() => {
      latestES.onmessage?.({ data: JSON.stringify(shellEvt) })
      latestES.onmessage?.({ data: JSON.stringify(runtimeEvt) })
    })

    // All shows both
    expect(screen.getByTestId('event-e1')).toBeInTheDocument()
    expect(screen.getByTestId('event-e2')).toBeInTheDocument()

    // Filter to Shell
    fireEvent.click(screen.getByText('Shell'))

    expect(screen.getByTestId('event-e1')).toBeInTheDocument()
    expect(screen.queryByTestId('event-e2')).not.toBeInTheDocument()

    // Filter to Runtime
    fireEvent.click(screen.getByText('Runtime'))

    expect(screen.queryByTestId('event-e1')).not.toBeInTheDocument()
    expect(screen.getByTestId('event-e2')).toBeInTheDocument()
  })

  it('closes EventSource on unmount', () => {
    const { unmount } = render(<SessionPane threadId="thread-1" />)

    const es = latestES
    expect(es).not.toBeNull()

    unmount()

    expect(es.close).toHaveBeenCalled()
  })
})
