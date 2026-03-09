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

import EventTimeline, { computeGroups, deriveGroupStatus } from '@/app/agents/[id]/EventTimeline'
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
    // "inference" appears in both EventCard and banner — verify via event card
    const card = screen.getByTestId('event-card')
    expect(card).toHaveTextContent('inference')
  })
})

// ---------------------------------------------------------------------------
// Helper: create events at specific timestamps for grouping tests
// ---------------------------------------------------------------------------
const T0 = new Date('2026-01-01T00:00:00.000Z').getTime()

function makeEvent(
  overrides: Partial<AgentEvent> & { id: string; tool: string; type: string },
  offsetMs: number = 0,
): AgentEvent {
  return {
    timestamp: new Date(T0 + offsetMs).toISOString(),
    input_summary: 'test',
    output_summary: null,
    duration_ms: null,
    success: null,
    ...overrides,
  }
}

function inf(id: string, offsetMs: number): AgentEvent {
  return makeEvent({ id, tool: 'inference', type: 'inference_complete' }, offsetMs)
}

function wr(id: string, offsetMs: number, workId?: string): AgentEvent {
  return makeEvent(
    { id, tool: 'runtime', type: 'work_received', ...(workId ? { metadata: { work_id: workId } } : {}) },
    offsetMs,
  )
}

function wc(id: string, offsetMs: number, workId?: string): AgentEvent {
  return makeEvent(
    { id, tool: 'runtime', type: 'work_completed', ...(workId ? { metadata: { work_id: workId } } : {}) },
    offsetMs,
  )
}

function shell(id: string, offsetMs: number): AgentEvent {
  return makeEvent({ id, tool: 'shell', type: 'command_start' }, offsetMs)
}

function fs(id: string, offsetMs: number): AgentEvent {
  return makeEvent({ id, tool: 'filesystem', type: 'file_read' }, offsetMs)
}

function wf(id: string, offsetMs: number): AgentEvent {
  return makeEvent({ id, tool: 'runtime', type: 'work_failed' }, offsetMs)
}

// ---------------------------------------------------------------------------
// computeGroups — positive tests (strong signal present → grouped)
// ---------------------------------------------------------------------------
describe('computeGroups — positive (grouped)', () => {
  it('G1: shared work_id groups runtime events', () => {
    const events = [wr('a', 0, 'X'), wc('b', 100, 'X')]
    const groups = computeGroups(events)
    expect(groups.size).toBe(2)
    expect(groups.get('a')).toBe(groups.get('b'))
  })

  it('G2: shared work_id groups across large gap (non-adjacent)', () => {
    const events = [wr('a', 0, 'X'), shell('s', 5000), wc('b', 10000, 'X')]
    const groups = computeGroups(events)
    expect(groups.get('a')).toBe(groups.get('b'))
    expect(groups.has('s')).toBe(false) // shell is solo
  })

  it('G3: inference → work_received ≤3s, adjacent', () => {
    const events = [inf('a', 0), wr('b', 500)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(2)
    expect(groups.get('a')).toBe(groups.get('b'))
  })

  it('G4: inference → work_completed ≤3s, adjacent', () => {
    const events = [inf('a', 0), wc('b', 300)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(2)
    expect(groups.get('a')).toBe(groups.get('b'))
  })

  it('G5: full step: inference + work_received + work_completed (transitive)', () => {
    const events = [inf('a', 0), wr('b', 300, 'X'), wc('c', 500, 'X')]
    const groups = computeGroups(events)
    expect(groups.size).toBe(3)
    const groupId = groups.get('a')
    expect(groups.get('b')).toBe(groupId)
    expect(groups.get('c')).toBe(groupId)
  })

  it('G6: two separate steps with gap', () => {
    const events = [
      inf('a1', 0), wr('b1', 300, 'A'), wc('c1', 500, 'A'),
      inf('a2', 5000), wr('b2', 5300, 'B'), wc('c2', 5500, 'B'),
    ]
    const groups = computeGroups(events)
    expect(groups.size).toBe(6)
    // First step grouped together
    expect(groups.get('a1')).toBe(groups.get('b1'))
    expect(groups.get('b1')).toBe(groups.get('c1'))
    // Second step grouped together
    expect(groups.get('a2')).toBe(groups.get('b2'))
    expect(groups.get('b2')).toBe(groups.get('c2'))
    // Different groups
    expect(groups.get('a1')).not.toBe(groups.get('a2'))
  })

  it('G7: non-adjacent work_id linking via index', () => {
    const events = [wr('a', 0, 'X'), inf('i', 500), shell('s', 1000), wc('b', 1500, 'X')]
    const groups = computeGroups(events)
    expect(groups.get('a')).toBe(groups.get('b'))
    // inf and shell are NOT in any group (no signal links them)
    expect(groups.has('i')).toBe(false)
    expect(groups.has('s')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeGroups — negative tests (no strong signal → NOT grouped)
// ---------------------------------------------------------------------------
describe('computeGroups — negative (not grouped)', () => {
  it('N1: two inference events ≤3s → NOT grouped', () => {
    const events = [inf('a', 0), inf('b', 1000)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N2: three rapid inference events → NOT grouped', () => {
    const events = [inf('a', 0), inf('b', 500), inf('c', 1000)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N3: inference → shell ≤3s → NOT grouped', () => {
    const events = [inf('a', 0), shell('b', 500)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N4: inference → filesystem ≤3s → NOT grouped', () => {
    const events = [inf('a', 0), fs('b', 500)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N5: runtime → inference ≤3s → NOT grouped (wrong direction)', () => {
    const events = [wr('a', 0), inf('b', 500)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N6: shell → runtime ≤3s → NOT grouped', () => {
    const events = [shell('a', 0), wr('b', 500)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N7: inference → work_received >3s → NOT grouped', () => {
    const events = [inf('a', 0), wr('b', 4000)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })

  it('N8: inference → work_received ≤3s but NOT adjacent → NOT grouped', () => {
    const events = [inf('a', 0), shell('s', 200), wr('b', 500)]
    const groups = computeGroups(events)
    // inf and wr NOT linked (shell is between them)
    expect(groups.has('a')).toBe(false)
    expect(groups.has('b')).toBe(false)
  })

  it('N9: inference → work_failed ≤3s, adjacent → NOT grouped', () => {
    const events = [inf('a', 0), wf('b', 300)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeGroups — edge cases
// ---------------------------------------------------------------------------
describe('computeGroups — edge cases', () => {
  it('E1: empty events array', () => {
    const groups = computeGroups([])
    expect(groups.size).toBe(0)
  })

  it('E2: single event', () => {
    const groups = computeGroups([inf('a', 0)])
    expect(groups.size).toBe(0)
  })

  it('E3: events with identical timestamps (inf + wr)', () => {
    const events = [inf('a', 0), wr('b', 0)]
    const groups = computeGroups(events)
    expect(groups.size).toBe(2)
    expect(groups.get('a')).toBe(groups.get('b'))
  })

  it('E4: missing metadata on runtime event (Signal B still works)', () => {
    const events = [inf('a', 0), wr('b', 500)]
    // wr has no metadata/work_id, but Signal B (adjacency) should still fire
    const groups = computeGroups(events)
    expect(groups.size).toBe(2)
    expect(groups.get('a')).toBe(groups.get('b'))
  })

  it('E5: work_id on only one of two runtime events → NOT grouped via Signal A', () => {
    const events = [
      wr('a', 0, 'X'),
      makeEvent({ id: 'b', tool: 'runtime', type: 'work_completed' }, 100), // no work_id
    ]
    const groups = computeGroups(events)
    // No shared work_id → Signal A doesn't fire
    // runtime→runtime is not a Signal B pattern (requires inference→runtime)
    expect(groups.has('a')).toBe(false)
    expect(groups.has('b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rendering tests — group spine and layout
// ---------------------------------------------------------------------------
describe('EventTimeline — group rendering', () => {
  function setupSSEAndSendEvents(events: AgentEvent[]) {
    let capturedOnMessage: ((msg: MessageEvent) => void) | null = null
    vi.stubGlobal('EventSource', vi.fn(() => {
      const instance = {
        onmessage: null as any,
        addEventListener: vi.fn(),
        close: vi.fn(),
      }
      setTimeout(() => { capturedOnMessage = instance.onmessage }, 0)
      return instance
    }))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)

    return waitFor(() => expect(capturedOnMessage).toBeTruthy()).then(() => {
      for (const e of events) {
        capturedOnMessage!(new MessageEvent('message', { data: JSON.stringify(e) }))
      }
      return capturedOnMessage!
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => cleanup())

  it('R1: multi-event group shows spine', async () => {
    await setupSSEAndSendEvents([inf('a', 0), wr('b', 500)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
    expect(screen.getByTestId('group-spine')).toBeInTheDocument()
  })

  it('R2: solo event has no spine', async () => {
    await setupSSEAndSendEvents([inf('a', 0)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    expect(screen.queryByTestId('group-spine')).not.toBeInTheDocument()
  })

  it('R3: group wrapper has pl-3 class', async () => {
    await setupSSEAndSendEvents([inf('a', 0), wr('b', 500)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
    const spine = screen.getByTestId('group-spine')
    expect(spine.parentElement).toHaveClass('pl-3')
  })

  it('R4: existing EventCard/EventTimeline tests pass (no regression)', async () => {
    // This is validated by the full test suite running without failures
    // Included here as an explicit marker
    await setupSSEAndSendEvents([
      { ...MOCK_EVENTS[0], id: 'reg-1' },
      { ...MOCK_EVENTS[1], id: 'reg-2' },
    ])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
  })

  it('R5: outer container uses space-y-3', async () => {
    await setupSSEAndSendEvents([inf('a', 0)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    const container = screen.getByTestId('event-card').closest('.space-y-3')
    expect(container).toBeInTheDocument()
  })

  it('R6: filter change recomputes — inference-only filter shows no spine', async () => {
    const onMessage = await setupSSEAndSendEvents([inf('a', 0), wr('b', 500)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
    // Spine should be visible with All filter
    expect(screen.getByTestId('group-spine')).toBeInTheDocument()

    // Switch to Inference filter
    fireEvent.click(screen.getByText('Inference'))

    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    // No runtime events visible → no Signal B → no spine
    expect(screen.queryByTestId('group-spine')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// deriveGroupStatus — pure function tests (GS1-GS8)
// ---------------------------------------------------------------------------
describe('deriveGroupStatus', () => {
  it('GS1: work_received + work_completed → completed', () => {
    const events = [wr('a', 0), wc('b', 100)]
    expect(deriveGroupStatus(events)).toBe('completed')
  })

  it('GS2: work_received + work_failed → failed', () => {
    const events = [wr('a', 0), wf('b', 100)]
    expect(deriveGroupStatus(events)).toBe('failed')
  })

  it('GS3: work_received only → in_progress', () => {
    const events = [wr('a', 0)]
    expect(deriveGroupStatus(events)).toBe('in_progress')
  })

  it('GS4: work_failed takes precedence over work_completed', () => {
    const events = [wr('a', 0), wc('b', 100), wf('c', 200)]
    expect(deriveGroupStatus(events)).toBe('failed')
  })

  it('GS5: realistic full step: inference + work_received + work_completed → completed', () => {
    const events = [inf('a', 0), wr('b', 300), wc('c', 500)]
    expect(deriveGroupStatus(events)).toBe('completed')
  })

  it('GS6: no runtime work-step events → null (no badge)', () => {
    const events = [inf('a', 0), shell('b', 100)]
    expect(deriveGroupStatus(events)).toBeNull()
  })

  it('GS7: inference_error + work_completed → completed NOT failed', () => {
    const inferenceError = makeEvent(
      { id: 'ie', tool: 'inference', type: 'inference_error', success: false },
      50,
    )
    const events = [wr('a', 0), inferenceError, wc('b', 100)]
    expect(deriveGroupStatus(events)).toBe('completed')
  })

  it('GS8: shell command_complete (success=false) does NOT affect group status', () => {
    const shellFail = makeEvent(
      { id: 'sf', tool: 'shell', type: 'command_complete', success: false },
      50,
    )
    const events = [wr('a', 0), shellFail, wc('b', 100)]
    expect(deriveGroupStatus(events)).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Latest Activity banner rendering tests (LA1-LA5)
// ---------------------------------------------------------------------------
describe('EventTimeline — Latest Activity banner', () => {
  function setupSSEAndSendEvents(events: AgentEvent[]) {
    let capturedOnMessage: ((msg: MessageEvent) => void) | null = null
    vi.stubGlobal('EventSource', vi.fn(() => {
      const instance = {
        onmessage: null as any,
        addEventListener: vi.fn(),
        close: vi.fn(),
      }
      setTimeout(() => { capturedOnMessage = instance.onmessage }, 0)
      return instance
    }))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)

    return waitFor(() => expect(capturedOnMessage).toBeTruthy()).then(() => {
      for (const e of events) {
        capturedOnMessage!(new MessageEvent('message', { data: JSON.stringify(e) }))
      }
      return capturedOnMessage!
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => cleanup())

  it('LA1: banner shows when events exist', async () => {
    await setupSSEAndSendEvents([
      makeEvent({ id: 'e1', tool: 'shell', type: 'command_start', input_summary: 'echo hello' }, 0),
    ])
    await waitFor(() => {
      expect(screen.getByTestId('latest-activity')).toBeInTheDocument()
    })
  })

  it('LA2: banner not shown when no events', () => {
    vi.stubGlobal('EventSource', vi.fn(() => ({
      onmessage: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    })))
    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)
    expect(screen.queryByTestId('latest-activity')).not.toBeInTheDocument()
  })

  it('LA3: banner shows most recent event tool', async () => {
    await setupSSEAndSendEvents([
      makeEvent({ id: 'e1', tool: 'shell', type: 'command_start', input_summary: 'echo hello' }, 0),
      makeEvent({ id: 'e2', tool: 'filesystem', type: 'file_read', input_summary: '/tmp/data.txt' }, 100),
    ])
    await waitFor(() => {
      const banner = screen.getByTestId('latest-activity')
      expect(banner).toHaveTextContent('filesystem')
    })
  })

  it('LA4: banner shows input_summary', async () => {
    await setupSSEAndSendEvents([
      makeEvent({ id: 'e1', tool: 'shell', type: 'command_start', input_summary: 'npm run build' }, 0),
    ])
    await waitFor(() => {
      const banner = screen.getByTestId('latest-activity')
      expect(banner).toHaveTextContent('npm run build')
    })
  })

  it('LA5: banner updates when new event arrives via SSE', async () => {
    const onMessage = await setupSSEAndSendEvents([
      makeEvent({ id: 'e1', tool: 'shell', type: 'command_start', input_summary: 'first command' }, 0),
    ])
    await waitFor(() => {
      expect(screen.getByTestId('latest-activity')).toHaveTextContent('first command')
    })
    // Send a second event
    onMessage(new MessageEvent('message', {
      data: JSON.stringify(
        makeEvent({ id: 'e2', tool: 'runtime', type: 'work_received', input_summary: 'second event' }, 200),
      ),
    }))
    await waitFor(() => {
      expect(screen.getByTestId('latest-activity')).toHaveTextContent('second event')
    })
  })
})

// ---------------------------------------------------------------------------
// Group status badge rendering tests (SB1-SB6)
// ---------------------------------------------------------------------------
describe('EventTimeline — group status badges', () => {
  function setupSSEAndSendEvents(events: AgentEvent[]) {
    let capturedOnMessage: ((msg: MessageEvent) => void) | null = null
    vi.stubGlobal('EventSource', vi.fn(() => {
      const instance = {
        onmessage: null as any,
        addEventListener: vi.fn(),
        close: vi.fn(),
      }
      setTimeout(() => { capturedOnMessage = instance.onmessage }, 0)
      return instance
    }))

    render(<EventTimeline agentId="uuid-1" agentStatus="running" />)

    return waitFor(() => expect(capturedOnMessage).toBeTruthy()).then(() => {
      for (const e of events) {
        capturedOnMessage!(new MessageEvent('message', { data: JSON.stringify(e) }))
      }
      return capturedOnMessage!
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => cleanup())

  it('SB1: completed group shows Completed badge', async () => {
    // Full step: inference → work_received → work_completed (grouped via Signal A + B)
    await setupSSEAndSendEvents([inf('a', 0), wr('b', 300, 'W1'), wc('c', 500, 'W1')])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(3)
    })
    const badge = screen.getByTestId('group-status-badge')
    expect(badge).toHaveTextContent('Completed')
  })

  it('SB2: badge has brand-400 color for completed', async () => {
    await setupSSEAndSendEvents([inf('a', 0), wr('b', 300, 'W1'), wc('c', 500, 'W1')])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(3)
    })
    const badge = screen.getByTestId('group-status-badge')
    expect(badge.className).toContain('text-brand-400')
  })

  it('SB3: in_progress badge has pulsing dot', async () => {
    // Only work_received, no closing event — need to be grouped (so add inference for Signal B)
    await setupSSEAndSendEvents([inf('a', 0), wr('b', 300)])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
    const badge = screen.getByTestId('group-status-badge')
    expect(badge).toHaveTextContent('In Progress')
    const dot = badge.querySelector('.animate-pulse')
    expect(dot).toBeInTheDocument()
  })

  it('SB4: no badge on ungrouped events', async () => {
    // Solo shell event — not grouped
    await setupSSEAndSendEvents([
      makeEvent({ id: 'solo', tool: 'shell', type: 'command_start', input_summary: 'ls' }, 0),
    ])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    expect(screen.queryByTestId('group-status-badge')).not.toBeInTheDocument()
  })

  it('SB5: no badge on group without runtime work-step events', async () => {
    // Two inference events sharing a work_id — grouped but no runtime work-step events
    const i1 = makeEvent(
      { id: 'i1', tool: 'inference', type: 'inference_complete', metadata: { work_id: 'Z' } },
      0,
    )
    const i2 = makeEvent(
      { id: 'i2', tool: 'inference', type: 'inference_complete', metadata: { work_id: 'Z' } },
      100,
    )
    await setupSSEAndSendEvents([i1, i2])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(2)
    })
    // They share work_id so they ARE grouped (spine visible)
    expect(screen.getByTestId('group-spine')).toBeInTheDocument()
    // But no runtime work-step events → no badge
    expect(screen.queryByTestId('group-status-badge')).not.toBeInTheDocument()
  })

  it('SB6: existing OK/FAIL indicators unchanged', async () => {
    const completedEvent = makeEvent(
      { id: 'ok1', tool: 'shell', type: 'command_complete', success: true, input_summary: 'echo hi' },
      0,
    )
    await setupSSEAndSendEvents([completedEvent])
    await waitFor(() => {
      expect(screen.getAllByTestId('event-card')).toHaveLength(1)
    })
    expect(screen.getByText('OK')).toBeInTheDocument()
  })
})
