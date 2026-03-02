import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: any }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock next/navigation
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock confirm/alert
vi.stubGlobal('confirm', vi.fn(() => true))
vi.stubGlobal('alert', vi.fn())

// Mock EventTimeline to avoid EventSource in tests
vi.mock('@/app/agents/[id]/EventTimeline', () => ({
  default: ({ agentId, agentStatus }: { agentId: string; agentStatus: string }) => (
    <div data-testid="event-timeline">EventTimeline: {agentStatus}</div>
  ),
}))

import AgentDetailClient from '@/app/agents/[id]/AgentDetailClient'

const MOCK_AGENT = {
  id: 'uuid-1',
  agent_id: 'research-bot',
  name: 'ResearchBot',
  description: 'Researches topics and summarizes findings',
  status: 'stopped',
  cpus: '1.0',
  mem_limit: '1g',
  pids_limit: 200,
  tools_config: {
    shell: { enabled: true, allowed_binaries: ['bash', 'python3'], denied_patterns: ['rm -rf'], max_timeout: 600 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
    health: { enabled: true },
  },
  soul_md: 'You are a research assistant.',
  rules_md: 'Always cite sources.',
  container_id: null,
  model_policy_id: 'policy-1',
  tool_preset_id: null,
  error_message: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  created_by: 'admin',
}

const MOCK_AGENT_WITH_PRESET = {
  ...MOCK_AGENT,
  tool_preset_id: 'preset-dev',
}

const MOCK_PRESETS = [
  {
    id: 'preset-dev',
    name: 'Developer',
    description: 'Full dev environment',
    tools_config: {},
    is_platform: true,
  },
]

const MOCK_POLICIES = [
  {
    id: 'policy-1',
    name: 'Default Policy',
    allowed_models: ['gpt-4o-mini', 'claude-sonnet-4-5-20250929'],
    max_requests_per_minute: 60,
    max_tokens_per_day: 100000,
    created_by: null,
  },
]

const MOCK_USAGE = {
  total_requests: 150,
  total_tokens: 25000,
  total_cost_usd: '3.50',
}

const MOCK_KNOWLEDGE_ENTRIES = [
  { id: '1', agent_id: 'research-bot', content: 'Some knowledge', created_at: '2026-01-10T00:00:00Z' },
  { id: '2', agent_id: 'research-bot', content: 'More knowledge', created_at: '2026-01-12T00:00:00Z' },
]

const ADMIN_SESSION = {
  user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const USER_SESSION = {
  user: { name: 'User', email: 'user@hill90.com', roles: ['user'] },
  expires: '2026-12-31',
}

function mockFetchDefaults(agentOverride?: typeof MOCK_AGENT) {
  mockFetch.mockImplementation((url: string) => {
    if (url === `/api/agents/uuid-1`) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agentOverride || MOCK_AGENT) })
    }
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    }
    if (url === '/api/tool-presets') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESETS) })
    }
    if (typeof url === 'string' && url.includes('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
    }
    if (typeof url === 'string' && url.includes('/api/knowledge/entries')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_ENTRIES) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders overview tab with status and config summary', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Overview tab should be active by default
    expect(screen.getByText('Overview')).toBeInTheDocument()
    // Status info
    expect(screen.getByText('stopped')).toBeInTheDocument()
    // Tool badges
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Filesystem')).toBeInTheDocument()
    expect(screen.getByText('Health')).toBeInTheDocument()
  })

  it('clicking Configuration tab shows tool details', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Configuration tab
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    // Should show detailed tool config
    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument()
    })
    expect(screen.getByText('python3')).toBeInTheDocument()
    expect(screen.getByText('rm -rf')).toBeInTheDocument()
    expect(screen.getByText('/workspace')).toBeInTheDocument()
  })

  it('fetches usage data only when Model Access tab clicked', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Usage should NOT be fetched on initial load
    const usageCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/usage')
    )
    expect(usageCalls).toHaveLength(0)

    // Click Model Access tab
    fireEvent.click(screen.getByRole('button', { name: 'Model Access' }))

    // Now usage should be fetched
    await waitFor(() => {
      const usageCallsAfter = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/usage')
      )
      expect(usageCallsAfter.length).toBeGreaterThan(0)
    })
  })

  it('fetches knowledge entries only when Knowledge tab clicked', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Knowledge should NOT be fetched on initial load
    const knowledgeCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/knowledge/entries')
    )
    expect(knowledgeCalls).toHaveLength(0)

    // Click Knowledge tab
    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    // Now knowledge should be fetched
    await waitFor(() => {
      const knowledgeCallsAfter = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/knowledge/entries')
      )
      expect(knowledgeCallsAfter.length).toBeGreaterThan(0)
    })
  })

  it('Activity tab visible to non-admin users', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument()
  })

  it('Activity tab visible to admin users', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument()
  })

  it('Raw Logs sub-view requires admin', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Activity tab
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

    // Non-admin should NOT see Raw Logs toggle
    expect(screen.queryByTestId('raw-logs-toggle')).not.toBeInTheDocument()
  })

  it('Raw Logs sub-view visible to admins', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Activity tab
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

    // Admin should see Raw Logs toggle
    expect(screen.getByTestId('raw-logs-toggle')).toBeInTheDocument()
  })

  it('Configuration tab displays allowed_binaries and denied_patterns', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument()
      expect(screen.getByText('python3')).toBeInTheDocument()
      expect(screen.getByText('rm -rf')).toBeInTheDocument()
    })
  })

  it('Model Access tab shows allowed models and limits', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Model Access' }))

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-5-20250929')).toBeInTheDocument()
  })

  // T22: Agent detail shows preset badge when assigned
  it('shows preset name badge when tool_preset_id is set', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_PRESET as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Should show the preset name in the Tool Access section
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
  })

  // T23: Agent detail shows Custom when no preset
  it('shows Custom when no preset assigned', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Should show "Custom" label in Tool Access since tool_preset_id is null
    expect(screen.getByText('Custom')).toBeInTheDocument()
  })
})
