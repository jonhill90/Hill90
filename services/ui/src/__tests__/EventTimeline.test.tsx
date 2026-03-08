import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Terminal: (props: any) => <span data-testid="icon-terminal" {...props} />,
  FolderOpen: (props: any) => <span data-testid="icon-folder" {...props} />,
  Cog: (props: any) => <span data-testid="icon-cog" {...props} />,
  User: (props: any) => <span data-testid="icon-user" {...props} />,
  HeartPulse: (props: any) => <span data-testid="icon-heart" {...props} />,
  ChevronDown: (props: any) => <span data-testid="icon-chevron-down" {...props} />,
  ChevronRight: (props: any) => <span data-testid="icon-chevron-right" {...props} />,
}))

import EventTimeline from '@/app/agents/[id]/EventTimeline'
import EventCard from '@/app/agents/[id]/EventCard'
import type { AgentEvent } from '@/app/agents/[id]/EventCard'

const MOCK_EVENTS: AgentEvent[] = [
  {
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    type: 'command_start',
    tool: 'shell',
    input_summary: 'echo hello',
    output_summary: null,
    duration_ms: null,
    success: null,
  },
  {
    id: 'evt-2',
    timestamp: new Date().toISOString(),
    type: 'command_complete',
    tool: 'shell',
    input_summary: 'echo hello',
    output_summary: 'exit 0, 6 bytes stdout',
    duration_ms: 15,
    success: true,
  },
  {
    id: 'evt-3',
    timestamp: new Date().toISOString(),
    type: 'file_read',
    tool: 'filesystem',
    input_summary: '/workspace/data.txt',
    output_summary: '1024 bytes',
    duration_ms: 2,
    success: true,
  },
]

describe('EventCard', () => {
  afterEach(() => cleanup())

  it('displays tool name and input summary', () => {
    render(<EventCard event={MOCK_EVENTS[1]} />)
    expect(screen.getByText('shell')).toBeInTheDocument()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })

  it('shows success indicator', () => {
    render(<EventCard event={MOCK_EVENTS[1]} />)
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('shows failure indicator', () => {
    const failedEvent: AgentEvent = {
      ...MOCK_EVENTS[1],
      id: 'evt-fail',
      success: false,
    }
    render(<EventCard event={failedEvent} />)
    expect(screen.getByText('FAIL')).toBeInTheDocument()
  })

  it('expands on click to show details', () => {
    render(<EventCard event={MOCK_EVENTS[1]} />)

    // Details should not be visible initially
    expect(screen.queryByTestId('event-details')).not.toBeInTheDocument()

    // Click to expand
    fireEvent.click(screen.getByTestId('event-card'))

    // Details should now be visible
    expect(screen.getByTestId('event-details')).toBeInTheDocument()
    expect(screen.getByText('exit 0, 6 bytes stdout')).toBeInTheDocument()
    expect(screen.getByText('command_complete')).toBeInTheDocument()
  })

  it('shows duration when available', () => {
    render(<EventCard event={MOCK_EVENTS[1]} />)
    expect(screen.getByText('15ms')).toBeInTheDocument()
  })
})

describe('EventTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom doesn't have scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => cleanup())

  it('shows not-running message when agent is stopped', () => {
    render(<EventTimeline agentId="uuid-1" agentStatus="stopped" />)
    expect(screen.getByText('Start the agent to see live activity.')).toBeInTheDocument()
  })

  it('shows waiting message when running but no events', () => {
    // Mock EventSource
    const mockClose = vi.fn()
    vi.stubGlobal('EventSource', vi.fn(() => ({
      onmessage: null,
      addEventListener: vi.fn(),
      close: mockClose,
    })))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)
    expect(screen.getByText('Waiting for events...')).toBeInTheDocument()
  })

  it('renders filter buttons', () => {
    vi.stubGlobal('EventSource', vi.fn(() => ({
      onmessage: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    })))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Filesystem')).toBeInTheDocument()
    expect(screen.getByText('Runtime')).toBeInTheDocument()
    // Identity and Health filters removed in Phase 2
    expect(screen.queryByText('Identity')).not.toBeInTheDocument()
    expect(screen.queryByText('Health')).not.toBeInTheDocument()
  })

  it('renders runtime event with cog icon', () => {
    vi.stubGlobal('EventSource', vi.fn(() => ({
      onmessage: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    })))

    const runtimeEvent: AgentEvent = {
      id: 'evt-runtime',
      timestamp: new Date().toISOString(),
      type: 'work_received',
      tool: 'runtime',
      input_summary: 'type=test',
      output_summary: null,
      duration_ms: null,
      success: null,
    }

    render(<EventCard event={runtimeEvent} />)
    expect(screen.getByTestId('icon-cog')).toBeInTheDocument()
    expect(screen.getByText('runtime')).toBeInTheDocument()
  })
})
