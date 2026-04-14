import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock EventCard to avoid importing the full agent EventCard tree
vi.mock('@/app/agents/[id]/EventCard', () => ({
  default: ({ event }: { event: any }) => (
    <div data-testid="event-card" data-event-id={event.id}>{event.tool}: {event.input_summary || event.summary}</div>
  ),
}))

// Mock XTerminal — it needs browser WebSocket + dynamic imports
vi.mock('@/app/chat/XTerminal', () => ({
  default: ({ threadId }: { threadId: string }) => (
    <div data-testid="xterminal-mock">XTerminal: {threadId}</div>
  ),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Terminal: ({ className }: any) => <span data-testid="icon-terminal" className={className} />,
  Activity: ({ className }: any) => <span data-testid="icon-activity" className={className} />,
  Globe: ({ className }: any) => <span data-testid="icon-globe" className={className} />,
  Monitor: ({ className }: any) => <span data-testid="icon-monitor" className={className} />,
  MousePointerClick: ({ className }: any) => <span data-testid="icon-mouse" className={className} />,
  ArrowLeft: ({ className }: any) => <span data-testid="icon-arrow-left" className={className} />,
  ArrowRight: ({ className }: any) => <span data-testid="icon-arrow-right" className={className} />,
  RotateCw: ({ className }: any) => <span data-testid="icon-rotate-cw" className={className} />,
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

function sendEvent(event: Record<string, unknown>) {
  act(() => {
    latestES?.onmessage?.({ data: JSON.stringify(event) })
  })
}

/** Click the Events tab to switch from default Terminal view */
function switchToEvents() {
  fireEvent.click(screen.getByText('Events'))
}

describe('SessionPane — view mode toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestES = null
  })

  afterEach(() => {
    cleanup()
  })

  it('renders session pane with Terminal and Events tabs', () => {
    render(<SessionPane threadId="thread-1" />)

    expect(screen.getByTestId('session-pane')).toBeInTheDocument()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.getByText('Events')).toBeInTheDocument()
  })

  it('defaults to Terminal view', () => {
    render(<SessionPane threadId="thread-1" />)

    // XTerminal mock should be rendered
    expect(screen.getByTestId('xterminal-mock')).toBeInTheDocument()
    expect(screen.getByTestId('xterminal-mock')).toHaveTextContent('thread-1')

    // Event filter buttons should NOT be visible
    expect(screen.queryByText('All')).not.toBeInTheDocument()
    expect(screen.queryByText('Shell')).not.toBeInTheDocument()
  })

  it('switches to Events view and shows filter buttons', () => {
    render(<SessionPane threadId="thread-1" />)

    switchToEvents()

    // Filter buttons appear
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Runtime')).toBeInTheDocument()
    expect(screen.getByText('Inference')).toBeInTheDocument()

    // XTerminal is hidden
    expect(screen.queryByTestId('xterminal-mock')).not.toBeInTheDocument()
  })

  it('switches back to Terminal view', () => {
    render(<SessionPane threadId="thread-1" />)

    switchToEvents()
    expect(screen.queryByTestId('xterminal-mock')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Terminal'))
    expect(screen.getByTestId('xterminal-mock')).toBeInTheDocument()
  })
})

describe('SessionPane — Events view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestES = null
  })

  afterEach(() => {
    cleanup()
  })

  it('connects EventSource to thread events endpoint', () => {
    render(<SessionPane threadId="thread-42" />)

    expect(latestES).not.toBeNull()
    expect(latestES.url).toBe('/api/chat/thread-42/events?follow=true&tail=20')
  })

  it('shows "Waiting for events..." when empty', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()
    expect(screen.getByTestId('no-events')).toHaveTextContent('Waiting for events...')
  })

  it('renders events received via SSE', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()

    sendEvent({
      id: 'evt-1', tool: 'shell', type: 'command_start',
      input_summary: 'ls output', timestamp: '2026-01-01T00:00:00Z',
      output_summary: null, duration_ms: null, success: null, metadata: {},
    })

    expect(screen.getByText('shell: ls output')).toBeInTheDocument()
  })

  it('filters events by tool type', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()

    sendEvent({
      id: 'e1', tool: 'shell', type: 'command_start',
      input_summary: 'cmd', timestamp: '2026-01-01T00:00:00Z',
      output_summary: null, duration_ms: null, success: null, metadata: {},
    })
    sendEvent({
      id: 'e2', tool: 'runtime', type: 'work_received',
      input_summary: 'start', timestamp: '2026-01-01T00:00:01Z',
      output_summary: null, duration_ms: null, success: null, metadata: {},
    })

    // All shows both
    expect(screen.getAllByTestId('event-card').length).toBe(2)

    // Filter to Shell
    fireEvent.click(screen.getByText('Shell'))
    expect(screen.getAllByTestId('event-card').length).toBe(1)
    expect(screen.getByText('shell: cmd')).toBeInTheDocument()

    // Filter to Runtime
    fireEvent.click(screen.getByText('Runtime'))
    expect(screen.getAllByTestId('event-card').length).toBe(1)
    expect(screen.getByText('runtime: start')).toBeInTheDocument()
  })

  it('closes EventSource on unmount', () => {
    const { unmount } = render(<SessionPane threadId="thread-1" />)

    const es = latestES
    expect(es).not.toBeNull()

    unmount()

    expect(es.close).toHaveBeenCalled()
  })
})

// ── TerminalBlock tests (AI-151) ──

describe('SessionPane TerminalBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestES = null
  })

  afterEach(() => {
    cleanup()
  })

  it('renders terminal output lines in TerminalBlock (T5)', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()

    sendEvent({
      id: 'e1', timestamp: new Date().toISOString(), type: 'command_start',
      tool: 'shell', input_summary: 'echo hello', output_summary: null,
      duration_ms: null, success: null, metadata: { command_id: 'cmd-1' },
    })
    sendEvent({
      id: 'e2', timestamp: new Date().toISOString(), type: 'command_output',
      tool: 'shell', input_summary: 'echo hello', output_summary: 'hello world',
      duration_ms: null, success: null, metadata: { command_id: 'cmd-1' },
    })
    sendEvent({
      id: 'e3', timestamp: new Date().toISOString(), type: 'command_output',
      tool: 'shell', input_summary: 'echo hello', output_summary: 'second line',
      duration_ms: null, success: null, metadata: { command_id: 'cmd-1' },
    })
    sendEvent({
      id: 'e4', timestamp: new Date().toISOString(), type: 'command_complete',
      tool: 'shell', input_summary: 'echo hello', output_summary: 'exit 0, 23 bytes stdout',
      duration_ms: 50, success: true, metadata: { command_id: 'cmd-1' },
    })

    const termBlock = screen.getByTestId('terminal-block')
    expect(termBlock).toBeInTheDocument()
    expect(termBlock.textContent).toContain('hello world')
    expect(termBlock.textContent).toContain('second line')

    // EventCards for start + complete only (command_output consumed by TerminalBlock)
    const eventCards = screen.getAllByTestId('event-card')
    expect(eventCards.length).toBe(2)
  })

  it('auto-scrolls TerminalBlock on new output (T6)', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()

    sendEvent({
      id: 's1', timestamp: new Date().toISOString(), type: 'command_start',
      tool: 'shell', input_summary: 'ls', output_summary: null,
      duration_ms: null, success: null, metadata: { command_id: 'cmd-2' },
    })

    for (let i = 0; i < 10; i++) {
      sendEvent({
        id: `o${i}`, timestamp: new Date().toISOString(), type: 'command_output',
        tool: 'shell', input_summary: 'ls', output_summary: `file-${i}.txt`,
        duration_ms: null, success: null, metadata: { command_id: 'cmd-2' },
      })
    }

    sendEvent({
      id: 'c1', timestamp: new Date().toISOString(), type: 'command_complete',
      tool: 'shell', input_summary: 'ls', output_summary: 'exit 0, 100 bytes stdout',
      duration_ms: 20, success: true, metadata: { command_id: 'cmd-2' },
    })

    const termBlock = screen.getByTestId('terminal-block')
    expect(termBlock).toBeInTheDocument()
    expect(termBlock.textContent).toContain('file-9.txt')
  })

  it('filters command_output with Shell filter (T7)', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToEvents()

    sendEvent({
      id: 'r1', timestamp: new Date().toISOString(), type: 'work_received',
      tool: 'runtime', input_summary: 'chat work', output_summary: null,
      duration_ms: null, success: null, metadata: {},
    })
    sendEvent({
      id: 's1', timestamp: new Date().toISOString(), type: 'command_start',
      tool: 'shell', input_summary: 'echo hi', output_summary: null,
      duration_ms: null, success: null, metadata: { command_id: 'cmd-3' },
    })
    sendEvent({
      id: 'o1', timestamp: new Date().toISOString(), type: 'command_output',
      tool: 'shell', input_summary: 'echo hi', output_summary: 'hi',
      duration_ms: null, success: null, metadata: { command_id: 'cmd-3' },
    })
    sendEvent({
      id: 'c1', timestamp: new Date().toISOString(), type: 'command_complete',
      tool: 'shell', input_summary: 'echo hi', output_summary: 'exit 0, 3 bytes stdout',
      duration_ms: 10, success: true, metadata: { command_id: 'cmd-3' },
    })

    // All — terminal block + 3 event cards (runtime + start + complete)
    expect(screen.getByTestId('terminal-block')).toBeInTheDocument()
    expect(screen.getAllByTestId('event-card').length).toBe(3)

    // Shell filter — terminal + 2 cards (start + complete)
    fireEvent.click(screen.getByText('Shell'))
    expect(screen.getByTestId('terminal-block')).toBeInTheDocument()
    expect(screen.getAllByTestId('event-card').length).toBe(2)

    // Runtime filter — no terminal, 1 card
    fireEvent.click(screen.getByText('Runtime'))
    expect(screen.queryByTestId('terminal-block')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('event-card').length).toBe(1)
  })
})

// ── Browser tab tests (AI-177) ──

function switchToBrowser() {
  fireEvent.click(screen.getByText('Browser'))
}

describe('SessionPane — Browser tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestES = null
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Browser tab button', () => {
    render(<SessionPane threadId="thread-1" />)
    expect(screen.getByTestId('browser-tab')).toBeInTheDocument()
    expect(screen.getByText('Browser')).toBeInTheDocument()
  })

  it('shows inactive state when no browser events', async () => {
    // Mock fetch to return 404 (no browser active)
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/screenshot')) return Promise.resolve({ ok: false, status: 404 })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<SessionPane threadId="thread-1" />)
    switchToBrowser()

    await waitFor(() => {
      expect(screen.getByTestId('browser-inactive')).toBeInTheDocument()
    })
    expect(screen.getByText('Browser not active')).toBeInTheDocument()
  })

  it('hides terminal and events when browser tab active', () => {
    render(<SessionPane threadId="thread-1" />)
    switchToBrowser()

    expect(screen.queryByTestId('xterminal-mock')).not.toBeInTheDocument()
    expect(screen.queryByText('All')).not.toBeInTheDocument()
  })

  it('shows screenshot when poll returns data', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/screenshot')) return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ screenshot: 'iVBORw0KGgo=', url: 'https://example.com' }),
      })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<SessionPane threadId="thread-1" />)
    switchToBrowser()

    await waitFor(() => {
      expect(screen.getByTestId('browser-screenshot')).toBeInTheDocument()
    })
    const urlInput = screen.getByTestId('browser-url-input') as HTMLInputElement
    expect(urlInput.value).toBe('https://example.com')
  })

  it('shows latest screenshot from polling', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/screenshot')) return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ screenshot: 'LATEST_PNG_DATA', url: 'https://latest.com' }),
      })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<SessionPane threadId="thread-1" />)
    switchToBrowser()

    await waitFor(() => {
      const urlInput = screen.getByTestId('browser-url-input') as HTMLInputElement
      expect(urlInput.value).toBe('https://latest.com')
    })
  })
})
