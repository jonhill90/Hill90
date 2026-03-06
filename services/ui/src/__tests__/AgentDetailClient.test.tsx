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
  models: ['gpt-4o-mini', 'claude-sonnet-4-5-20250929'],
  skills: [],
  error_message: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  created_by: 'admin',
}

const MOCK_AGENT_WITH_SKILL = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'preset-dev',
      name: 'Developer',
      scope: 'container_local',
      tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }],
      instructions_md: 'Always write tests before implementation.\nFollow TDD red-green-refactor.',
    },
  ],
}

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

const MOCK_ALL_SKILLS = [
  { id: 'preset-dev', name: 'Developer', scope: 'container_local', tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }], instructions_md: 'Dev instructions' },
  { id: 'skill-docker', name: 'Docker Access', scope: 'host_docker', tools: [], instructions_md: 'Docker instructions' },
  { id: 'skill-vps', name: 'VPS Admin', scope: 'vps_system', tools: [], instructions_md: 'VPS instructions' },
]

const MOCK_TOOL_INSTALLS = [
  {
    tool_id: 'tool-gh',
    tool_name: 'gh',
    tool_description: 'GitHub CLI',
    status: 'installed',
    install_message: 'installed',
    installed_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
  },
]

const MOCK_AGENT_WITH_MULTI_SKILLS = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'preset-dev',
      name: 'Developer',
      scope: 'container_local',
      tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }],
      instructions_md: 'Dev instructions.',
    },
    {
      id: 'skill-docker',
      name: 'Docker Access',
      scope: 'host_docker',
      tools: [],
      instructions_md: 'Docker instructions here.',
    },
  ],
}

const MOCK_AGENT_WITH_ELEVATED_SKILL = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'skill-docker',
      name: 'Docker Access',
      scope: 'host_docker',
      tools: [],
      instructions_md: 'Docker instructions here.',
    },
  ],
}

function mockFetchDefaults(agentOverride?: typeof MOCK_AGENT) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === `/api/agents/uuid-1` && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agentOverride || MOCK_AGENT) })
    }
    if (url === '/api/skills') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ALL_SKILLS) })
    }
    if (typeof url === 'string' && url.includes('/api/agents/uuid-1/tool-installs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOL_INSTALLS) })
    }
    if (typeof url === 'string' && url.includes('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
    }
    if (typeof url === 'string' && url.includes('/api/knowledge/entries')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_ENTRIES) })
    }
    if (typeof url === 'string' && url.includes('/skills') && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    if (typeof url === 'string' && url.includes('/skills/') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
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
    expect(screen.getByText('Tool Install Status')).toBeInTheDocument()
    expect(screen.getByText('gh')).toBeInTheDocument()
    expect(screen.getAllByText('installed').length).toBeGreaterThan(0)
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

  it('Configuration tab displays allowed_binaries', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument()
      expect(screen.getByText('python3')).toBeInTheDocument()
    })
  })

  it('Model Access tab shows assigned models', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Model Access' }))

    await waitFor(() => {
      expect(screen.getByText('Assigned Models')).toBeInTheDocument()
    })
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-5-20250929')).toBeInTheDocument()
  })

  // T1: Detail skills card renders each skill with name and scope badge
  it('renders skills list with scope badges', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Skills card should show skill name and scope badge
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    // Multiple "Container" badges may appear (skills card + assign picker)
    expect(screen.getAllByText('Container').length).toBeGreaterThan(0)
  })

  // T2: Detail skills card empty state
  it('shows no skills assigned when empty', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('No skills assigned')).toBeInTheDocument()
  })

  // T3: Detail assign skill calls POST
  it('assign skill calls POST endpoint', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Select Developer skill from picker
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Developer'))

    // Should have called POST /api/agents/uuid-1/skills
    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/skills') && c[1]?.method === 'POST'
      )
      expect(postCalls.length).toBeGreaterThan(0)
    })
  })

  // T4: Detail remove skill calls DELETE
  it('remove skill calls DELETE endpoint', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Click Remove button
    fireEvent.click(screen.getByText('Remove'))

    // Should have called DELETE
    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/skills/') && c[1]?.method === 'DELETE'
      )
      expect(deleteCalls.length).toBeGreaterThan(0)
    })
  })

  // T5: Remove hidden for non-admin on elevated skill
  it('remove hidden for non-admin on host_docker skill', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_ELEVATED_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Docker Access')).toBeInTheDocument()
    })

    // Non-admin should NOT see Remove button for host_docker skill
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
  })

  // T6: Remove shown for non-admin on container_local skill
  it('remove shown for non-admin on container_local skill', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Non-admin CAN see Remove button for container_local skill
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  // T7: Assign picker filters elevated scopes for non-admin
  it('assign picker excludes elevated skills for non-admin', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Should show container_local skill but NOT elevated ones
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    expect(screen.queryByText('Docker Access')).not.toBeInTheDocument()
    expect(screen.queryByText('VPS Admin')).not.toBeInTheDocument()
  })

  // U7: Assign picker excludes already-assigned skills
  it('assign picker excludes already-assigned skills', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Developer is already assigned -- should NOT appear in picker
    // But Docker Access and VPS Admin should appear (admin sees all)
    await waitFor(() => {
      expect(screen.getByText('Docker Access')).toBeInTheDocument()
    })
    expect(screen.getByText('VPS Admin')).toBeInTheDocument()

    // The picker should have items for Docker Access and VPS Admin but not Developer
    // Developer already appears in the skills list above, so we verify the picker
    // doesn't have a second clickable button for Developer
    const pickerButtons = screen.getAllByRole('button').filter(
      btn => btn.textContent?.includes('Developer') && btn.closest('[class*="navy-900"]')
    )
    // The picker is inside a navy-900 div -- should not have Developer there
    expect(pickerButtons).toHaveLength(0)
  })

  // U8: Detail shows multiple skill cards
  it('shows multiple skill cards', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_MULTI_SKILLS as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Both skills should appear
    expect(screen.getByText('Docker Access')).toBeInTheDocument()
  })

  // T8: Skill instructions toggle
  it('skill instructions expand on click', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Instructions should NOT be visible initially
    expect(screen.queryByText(/Always write tests before implementation/)).not.toBeInTheDocument()

    // Click "Show Instructions"
    fireEvent.click(screen.getByText('Show Instructions'))

    // Instructions should now be visible
    await waitFor(() => {
      expect(screen.getByText(/Always write tests before implementation/)).toBeInTheDocument()
    })
  })

  // U5: Detail shows NO kind badge — shows tools instead
  it('shows no kind badge on skill cards, shows tools instead', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Should NOT show "Skill" or "Profile" kind badges
    const skillCard = screen.getByText('Developer').closest('[class*="rounded-md"]')!
    expect(skillCard.textContent).not.toMatch(/\bSkill\b/)
    expect(skillCard.textContent).not.toContain('Profile')

    // Should show tools
    expect(screen.getByText('Tools: gh, git')).toBeInTheDocument()
  })

  // U6: Detail shows tools on skill cards
  it('shows tools as badges on skill cards', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Should show tool names
    expect(screen.getByText('Tools: gh, git')).toBeInTheDocument()
  })

})
