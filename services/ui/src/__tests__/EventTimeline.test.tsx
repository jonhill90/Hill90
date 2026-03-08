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
  Sparkles: (props: any) => <span data-testid="icon-sparkles" {...props} />,
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

const MOCK_INFERENCE_EVENT: AgentEvent = {
  id: 'inference-aaa00000-0000-0000-0000-000000000001',
  timestamp: new Date().toISOString(),
  type: 'inference_complete',
  tool: 'inference',
  input_summary: 'gpt-4o-mini (chat.completion)',
  output_summary: '1234+567 tokens, $0.0023, 450ms',
  duration_ms: 450,
  success: true,
  metadata: {
    model_name: 'gpt-4o-mini',
    request_type: 'chat.completion',
    status: 'success',
    input_tokens: 1234,
    output_tokens: 567,
    cost_usd: 0.0023,
  },
}

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

  // -------------------------------------------------------------------------
  // Inference card tests
  // -------------------------------------------------------------------------

  it('renders Sparkles icon for inference events', () => {
    render(<EventCard event={MOCK_INFERENCE_EVENT} />)
    expect(screen.getByTestId('icon-sparkles')).toBeInTheDocument()
    expect(screen.getByText('inference')).toBeInTheDocument()
  })

  it('inference card expanded shows structured model/tokens grid', () => {
    render(<EventCard event={MOCK_INFERENCE_EVENT} />)

    // Click to expand
    fireEvent.click(screen.getByTestId('event-card'))

    const details = screen.getByTestId('event-details')
    expect(details).toBeInTheDocument()
    // Structured grid fields
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('chat.completion')).toBeInTheDocument()
    expect(screen.getByText('1,234 tokens')).toBeInTheDocument()
    expect(screen.getByText('567 tokens')).toBeInTheDocument()
    expect(screen.getByText('$0.0023')).toBeInTheDocument()
    expect(screen.getByText('success')).toBeInTheDocument()
  })

  it('inference card expanded does NOT show raw JSON metadata', () => {
    render(<EventCard event={MOCK_INFERENCE_EVENT} />)
    fireEvent.click(screen.getByTestId('event-card'))
    // Should not have a <pre> with JSON.stringify output
    expect(screen.queryByText(/"model_name"/)).not.toBeInTheDocument()
  })

  it('Number() wrapping on cost_usd prevents toFixed crash', () => {
    // Simulate the Postgres numeric→string trap: cost_usd as string
    const eventWithStringCost: AgentEvent = {
      ...MOCK_INFERENCE_EVENT,
      id: 'inference-string-cost',
      metadata: {
        ...MOCK_INFERENCE_EVENT.metadata!,
        cost_usd: '0.005600' as unknown as number, // string from API
      },
    }
    render(<EventCard event={eventWithStringCost} />)
    fireEvent.click(screen.getByTestId('event-card'))
    // Number('0.005600').toFixed(4) = '0.0056'
    expect(screen.getByText('$0.0056')).toBeInTheDocument()
  })

  it('inference error event shows red status text', () => {
    const errorEvent: AgentEvent = {
      ...MOCK_INFERENCE_EVENT,
      id: 'inference-err',
      type: 'inference_error',
      success: false,
      metadata: {
        ...MOCK_INFERENCE_EVENT.metadata!,
        status: 'error',
      },
    }
    render(<EventCard event={errorEvent} />)
    expect(screen.getByText('FAIL')).toBeInTheDocument()
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
    const mockClose = vi.fn()
    vi.stubGlobal('EventSource', vi.fn(() => ({
      onmessage: null,
      addEventListener: vi.fn(),
      close: mockClose,
    })))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)
    expect(screen.getByText('Waiting for events...')).toBeInTheDocument()
  })

  it('renders filter buttons including Inference', () => {
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
    expect(screen.getByText('Inference')).toBeInTheDocument()
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

  it('Inference filter shows only inference events', async () => {
    let capturedOnMessage: ((msg: MessageEvent) => void) | null = null
    vi.stubGlobal('EventSource', vi.fn(() => {
      const instance = {
        onmessage: null as any,
        addEventListener: vi.fn(),
        close: vi.fn(),
      }
      // Capture onmessage after React sets it
      setTimeout(() => {
        capturedOnMessage = instance.onmessage
      }, 0)
      return instance
    }))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)

    // Wait for onmessage to be captured
    await waitFor(() => expect(capturedOnMessage).toBeTruthy())

    // Send a shell event and an inference event
    capturedOnMessage!(new MessageEvent('message', {
      data: JSON.stringify(MOCK_EVENTS[0]),
    }))
    capturedOnMessage!(new MessageEvent('message', {
      data: JSON.stringify(MOCK_INFERENCE_EVENT),
    }))

    // Verify both events are visible with All filter
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })

    // Click Inference filter
    fireEvent.click(screen.getByText('Inference'))

    // Only the inference event should be visible
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    expect(screen.getByText('inference')).toBeInTheDocument()
  })
})
