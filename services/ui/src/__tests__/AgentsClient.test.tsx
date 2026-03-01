import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: any }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentsClient from '@/app/agents/AgentsClient'

const MOCK_SESSION = {
  user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const MOCK_AGENTS = [
  {
    id: 'agent-1',
    agent_id: 'research-bot',
    name: 'ResearchBot',
    description: 'Researches topics',
    status: 'running',
    cpus: '0.5',
    mem_limit: '512m',
    pids_limit: 64,
    model_policy_id: 'policy-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'agent-2',
    agent_id: 'writer-bot',
    name: 'WriterBot',
    description: 'Writes content',
    status: 'stopped',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 128,
    model_policy_id: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    created_by: 'admin',
  },
]

const MOCK_POLICIES = [
  { id: 'policy-1', name: 'Default Policy' },
  { id: 'policy-2', name: 'Restricted Policy' },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders agent cards with names and status', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    expect(screen.getByText('2 agents')).toBeInTheDocument()
  })

  it('shows policy name badge on agents with assigned policy', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // ResearchBot has policy-1 assigned → should show "Default Policy" badge
    expect(screen.getByText('Default Policy')).toBeInTheDocument()
  })

  it('does not show policy badge on agents without policy', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    // WriterBot has no policy → "Restricted Policy" should not appear (only Default Policy is shown)
    const policyBadges = screen.queryAllByText('Restricted Policy')
    expect(policyBadges.length).toBe(0)
  })

  it('shows resource info on agent cards', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('0.5 CPU')).toBeInTheDocument()
    expect(screen.getByText('512m RAM')).toBeInTheDocument()
  })

  it('shows empty state when no agents', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (url === '/api/model-policies') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('No agents yet')).toBeInTheDocument()
    })
  })

  it('shows admin action buttons', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Running agent should have Stop button
    expect(screen.getByText('Stop')).toBeInTheDocument()
    // Stopped agent should have Start button
    expect(screen.getByText('Start')).toBeInTheDocument()
  })

  it('fetches both agents and policies on mount', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/agents')
    expect(mockFetch).toHaveBeenCalledWith('/api/model-policies')
  })
})
