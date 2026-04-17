import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('lucide-react', () => ({
  Terminal: (props: any) => <span data-testid="icon-terminal" {...props} />,
  FolderOpen: (props: any) => <span data-testid="icon-folder" {...props} />,
  Cog: (props: any) => <span data-testid="icon-cog" {...props} />,
  User: (props: any) => <span data-testid="icon-user" {...props} />,
  HeartPulse: (props: any) => <span data-testid="icon-heart" {...props} />,
  Sparkles: (props: any) => <span data-testid="icon-sparkles" {...props} />,
  ChevronDown: (props: any) => <span data-testid="icon-chevron-down" {...props} />,
  ChevronRight: (props: any) => <span data-testid="icon-chevron-right" {...props} />,
  MessageSquare: (props: any) => <span data-testid="icon-message" {...props} />,
  Globe: (props: any) => <span data-testid="icon-globe" {...props} />,
  BookOpen: (props: any) => <span data-testid="icon-book" {...props} />,
  LayoutGrid: (props: any) => <span data-testid="icon-grid" {...props} />,
}))

import EventCard, { parseExitCode, getLifecycleInfo, formatDuration } from '@/app/agents/[id]/EventCard'
import type { AgentEvent } from '@/app/agents/[id]/EventCard'

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    type: 'file_read',
    tool: 'filesystem',
    input_summary: '/workspace/data.txt',
    output_summary: '1024 bytes',
    duration_ms: null,
    success: null,
    ...overrides,
  }
}

describe('EventCard', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders tool name and input summary', () => {
    render(<EventCard event={makeEvent({ tool: 'shell', input_summary: 'echo hello' })} />)
    expect(screen.getByText('shell')).toBeInTheDocument()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })

  it('shows OK indicator for successful non-lifecycle event', () => {
    render(<EventCard event={makeEvent({ tool: 'filesystem', type: 'file_read', success: true })} />)
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('shows FAIL indicator for failed non-lifecycle event', () => {
    render(<EventCard event={makeEvent({ tool: 'filesystem', type: 'file_read', success: false })} />)
    expect(screen.getByText('FAIL')).toBeInTheDocument()
  })

  it('shows Running lifecycle label for command_start', () => {
    render(<EventCard event={makeEvent({ tool: 'shell', type: 'command_start', success: null })} />)
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('shows Completed lifecycle label for command_complete', () => {
    render(<EventCard event={makeEvent({ tool: 'shell', type: 'command_complete', success: true, output_summary: 'exit 0, 6 bytes' })} />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('shows Failed lifecycle label for work_failed', () => {
    render(<EventCard event={makeEvent({ tool: 'runtime', type: 'work_failed', success: false })} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('shows exit code on command_complete', () => {
    render(<EventCard event={makeEvent({ tool: 'shell', type: 'command_complete', success: true, output_summary: 'exit 0, 6 bytes' })} />)
    expect(screen.getByText('exit 0')).toBeInTheDocument()
  })

  it('shows duration when present', () => {
    render(<EventCard event={makeEvent({ duration_ms: 1500 })} />)
    expect(screen.getByText('1.5s')).toBeInTheDocument()
  })

  it('expands on click to show details', () => {
    render(<EventCard event={makeEvent()} />)
    expect(screen.queryByTestId('event-details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('event-card'))
    expect(screen.getByTestId('event-details')).toBeInTheDocument()
  })

  it('shows inference metadata in structured grid on expand', () => {
    render(
      <EventCard
        event={makeEvent({
          tool: 'inference',
          type: 'inference_complete',
          success: true,
          metadata: {
            model_name: 'gpt-4o-mini',
            request_type: 'chat',
            input_tokens: 100,
            output_tokens: 200,
            cost_usd: 0.0015,
            status: 'success',
          },
        })}
      />
    )
    fireEvent.click(screen.getByTestId('event-card'))
    expect(screen.getByTestId('event-details')).toBeInTheDocument()
    expect(screen.getByText('Model:')).toBeInTheDocument()
    expect(screen.getByText('Cost:')).toBeInTheDocument()
    expect(screen.getByText('Status:')).toBeInTheDocument()
  })
})

describe('parseExitCode', () => {
  it('returns null for null input', () => {
    expect(parseExitCode(null)).toBeNull()
  })

  it('extracts code from exit string', () => {
    expect(parseExitCode('exit 127, 0 bytes')).toBe(127)
  })
})

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s')
  })

  it('formats minutes', () => {
    expect(formatDuration(90000)).toBe('1m 30s')
  })
})
