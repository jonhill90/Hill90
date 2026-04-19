import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['admin'] } }, status: 'authenticated' }),
}))

vi.mock('lucide-react', () => ({
  Plus: (props: any) => <span data-testid="icon-plus" {...props} />,
  Play: (props: any) => <span data-testid="icon-play" {...props} />,
  Pause: (props: any) => <span data-testid="icon-pause" {...props} />,
  Trash2: (props: any) => <span data-testid="icon-trash" {...props} />,
  Clock: (props: any) => <span data-testid="icon-clock" {...props} />,
  Zap: (props: any) => <span data-testid="icon-zap" {...props} />,
  RefreshCw: (props: any) => <span data-testid="icon-refresh" {...props} />,
}))

import WorkflowsClient from '@/app/harness/workflows/WorkflowsClient'

const MOCK_WORKFLOWS = [
  {
    id: 'wf-1', name: 'Daily Health Check', description: 'Check services',
    agent_id: 'a-1', agent_name: 'Monitor Bot', agent_slug: 'monitor-bot', agent_status: 'running',
    schedule_cron: '0 9 * * *', prompt: 'Check all services', trigger_type: 'cron',
    output_type: 'none', output_config: {}, enabled: true, webhook_token: null,
    last_run_at: '2026-04-18T09:00:00Z', next_run_at: '2026-04-19T09:00:00Z', created_at: '2026-04-15T00:00:00Z',
  },
  {
    id: 'wf-2', name: 'PR Review Webhook', description: 'Review PRs on push',
    agent_id: 'a-2', agent_name: 'Review Bot', agent_slug: 'review-bot', agent_status: 'stopped',
    schedule_cron: null, prompt: 'Review the PR', trigger_type: 'webhook',
    output_type: 'none', output_config: {}, enabled: true, webhook_token: 'abc123def456',
    last_run_at: null, next_run_at: null, created_at: '2026-04-16T00:00:00Z',
  },
]

const MOCK_AGENTS = [
  { id: 'a-1', name: 'Monitor Bot', agent_id: 'monitor-bot', status: 'running' },
  { id: 'a-2', name: 'Review Bot', agent_id: 'review-bot', status: 'stopped' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
    if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkflowsClient', () => {
  it('renders workflow list', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Daily Health Check')).toBeInTheDocument()
      expect(screen.getByText('PR Review Webhook')).toBeInTheDocument()
    })
  })

  it('shows workflow count', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('2 workflows')).toBeInTheDocument()
    })
  })

  it('shows cron schedule for cron workflows', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Daily at 9:00')).toBeInTheDocument()
    })
  })

  it('shows webhook trigger for webhook workflows', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Webhook trigger')).toBeInTheDocument()
    })
  })

  it('shows active/paused badges', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      const badges = screen.getAllByText('Active')
      expect(badges.length).toBe(2)
    })
  })

  it('shows agent name and status', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
      expect(screen.getByText('(running)')).toBeInTheDocument()
    })
  })

  it('opens create form on New Workflow click', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('New Workflow')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('New Workflow'))
    expect(screen.getByText('Trigger')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Daily Health Check')).toBeInTheDocument()
  })

  it('shows empty state when no workflows', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('No workflows yet')).toBeInTheDocument()
    })
  })
})
