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
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
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
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    },
    model_policy_id: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'agent-3',
    agent_id: 'error-bot',
    name: 'ErrorBot',
    description: 'Has an error',
    status: 'error',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 128,
    tools_config: {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: false },
    },
    model_policy_id: null,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
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

    // Status badges + filter buttons both show these texts
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Stopped').length).toBeGreaterThan(0)
    expect(screen.getByText('3 agents')).toBeInTheDocument()
  })

  it('shows policy name badge on agents with assigned policy', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('Default Policy')).toBeInTheDocument()
  })

  it('does not show policy badge on agents without policy', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

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

    expect(screen.getByText('Stop')).toBeInTheDocument()
    expect(screen.getAllByText('Start').length).toBeGreaterThan(0)
  })

  it('fetches both agents and policies on mount', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/agents')
    expect(mockFetch).toHaveBeenCalledWith('/api/model-policies')
  })

  it('renders tool capability badges from tools_config', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // ResearchBot has shell + filesystem enabled, so should have both tool badges
    // Look for the Terminal and Folder icons via their aria-labels
    const shellBadges = screen.getAllByLabelText('Shell access')
    expect(shellBadges.length).toBeGreaterThan(0)

    const fsBadges = screen.getAllByLabelText('Filesystem access')
    expect(fsBadges.length).toBeGreaterThan(0)
  })

  it('status filter shows only matching agents', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Running" filter
    fireEvent.click(screen.getByRole('button', { name: /^Running$/i }))

    // Only ResearchBot should be visible
    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    expect(screen.queryByText('WriterBot')).not.toBeInTheDocument()
    expect(screen.queryByText('ErrorBot')).not.toBeInTheDocument()
  })

  it('running agents appear before stopped agents', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Get all agent name links in order
    const links = screen.getAllByRole('link').filter(
      (el) => ['ResearchBot', 'WriterBot', 'ErrorBot'].includes(el.textContent || '')
    )

    // Running agent should be first
    expect(links[0].textContent).toBe('ResearchBot')
  })
})
