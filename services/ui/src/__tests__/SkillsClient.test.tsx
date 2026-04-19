import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
let mockSession: any = {
  data: { user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] }, expires: '2026-12-31' },
  status: 'authenticated',
}
vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock confirm/alert
vi.stubGlobal('confirm', vi.fn(() => true))
vi.stubGlobal('alert', vi.fn())

import SkillsClient from '@/app/harness/skills/SkillsClient'
import { NAV_ITEMS, type NavGroup } from '@/components/nav-items'

const MOCK_SKILLS = [
  {
    id: 'preset-minimal',
    name: 'Minimal',
    description: 'Health monitoring only. No shell or filesystem access.',
    scope: 'container_local',
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have no shell or filesystem access. You can only monitor your own resource usage via the health endpoint.',
    is_platform: true,
    tools: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-dev',
    name: 'Developer',
    description: 'Full dev environment: bash, git, make, curl, jq. Read-write workspace and data.',
    scope: 'host_docker',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have full developer access with bash, git, make, curl, and jq available. Use /workspace as your primary working directory.',
    is_platform: true,
    tools: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-custom',
    name: 'CI Runner',
    description: 'Custom preset for CI pipelines.',
    scope: 'vps_system',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
    instructions_md: 'Run CI pipelines in isolated containers.',
    is_platform: false,
    tools: [
      { id: 'tool-gh', name: 'gh', description: 'GitHub CLI', install_method: 'binary' },
      { id: 'tool-git', name: 'git', description: 'VCS', install_method: 'builtin' },
    ],
    created_at: '2026-02-15T00:00:00Z',
    updated_at: '2026-02-15T00:00:00Z',
  },
]

const MOCK_TOOLS = [
  { id: 'tool-bash', name: 'bash', description: 'Shell', install_method: 'builtin', install_ref: '', is_platform: true },
  { id: 'tool-git', name: 'git', description: 'VCS', install_method: 'builtin', install_ref: '', is_platform: true },
  { id: 'tool-gh', name: 'gh', description: 'GitHub CLI', install_method: 'binary', install_ref: '', is_platform: true },
]

function mockFetchDefaults(skills = MOCK_SKILLS) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/skills' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(skills) })
    }
    if (url === '/api/tools' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOLS) })
    }
    if (url === '/api/skills' && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-preset', ...JSON.parse(opts.body) }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/skills/') && opts?.method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: url.split('/').pop(), ...JSON.parse(opts.body) }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/skills/') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('SkillsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = {
      data: { user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] }, expires: '2026-12-31' },
      status: 'authenticated',
    }
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  // T7: Skills page title says "Skills"
  it('page title shows Skills', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Skills')).toBeInTheDocument()
    })
    // Should show single count for all skills
    expect(screen.getByText('3 skills')).toBeInTheDocument()
  })

  // T8: Skills page shows instructions preview in expanded view
  it('expanding skill shows instructions preview', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Expand Developer skill
    fireEvent.click(screen.getByText('Developer'))

    await waitFor(() => {
      // Should show the instructions content
      expect(screen.getByText(/full developer access with bash/i)).toBeInTheDocument()
    })
  })

  // T9: Create form has instructions textarea
  it('create form includes instructions textarea', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Skill'))

    // Form should have "New Skill" heading
    expect(screen.getByText('New Skill')).toBeInTheDocument()

    // Should have instructions textarea
    expect(screen.getByPlaceholderText(/behavioral instructions/i)).toBeInTheDocument()
  })

  // T10: Edit form pre-fills instructions_md for seeded examples too
  it('edit form pre-fills instructions_md for seeded skills', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Developer'))

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Edit'))

    await waitFor(() => {
      expect(screen.getByText('Edit Skill')).toBeInTheDocument()
    })

    // Instructions textarea should be pre-filled
    const instructionsTextarea = screen.getByPlaceholderText(/behavioral instructions/i) as HTMLTextAreaElement
    expect(instructionsTextarea.value).toBe('You have full developer access with bash, git, make, curl, and jq available. Use /workspace as your primary working directory.')
  })

  // T14: Skills admin shows scope badge with correct labels
  it('skill row shows scope badge with tier-specific label', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // container_local -> "Container"
    expect(screen.getByText('Container')).toBeInTheDocument()
    // host_docker -> "Host . Docker"
    expect(screen.getByText('Host · Docker')).toBeInTheDocument()
    // vps_system -> "VPS . System"
    expect(screen.getByText('VPS · System')).toBeInTheDocument()
  })

  // U1: No separate Profiles/Skills sections — single flat list
  it('shows all skills in a single list without Profiles/Skills headings', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // Should NOT have separate section headings
    expect(screen.queryByText('Profiles (sandbox presets)')).not.toBeInTheDocument()
    expect(screen.queryByText('Skills (capabilities)')).not.toBeInTheDocument()

    // All three skills should be visible in a single list
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.getByText('CI Runner')).toBeInTheDocument()
  })

  // U2: Skill with tools shows tool badges
  it('Skill with tools shows tool badges', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('CI Runner')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('CI Runner'))

    await waitFor(() => {
      expect(screen.getByText('Tool Dependencies')).toBeInTheDocument()
    })

    const card = screen.getByText('CI Runner').closest('[class*="rounded-lg"]')!
    expect(within(card).getByText('gh')).toBeInTheDocument()
    expect(within(card).getByText('git')).toBeInTheDocument()
  })

  // U3: Create form has tool checkboxes
  it('SkillsClient create form has tool checkboxes', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Skill'))

    await waitFor(() => {
      expect(screen.getByText('New Skill')).toBeInTheDocument()
    })

    // Tool checkboxes should appear
    await waitFor(() => {
      expect(screen.getByText('Required Tools')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('bash')).toBeInTheDocument()
    expect(screen.getByLabelText('git')).toBeInTheDocument()
    expect(screen.getByLabelText('gh')).toBeInTheDocument()
  })

  // T5: create form does not send tools_config in request body
  it('create form does not send tools_config in request body', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Skill'))

    await waitFor(() => {
      expect(screen.getByText('New Skill')).toBeInTheDocument()
    })

    // Fill in name
    const nameInput = screen.getByPlaceholderText('Skill name')
    fireEvent.change(nameInput, { target: { value: 'Test Skill' } })

    // Submit
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (call: any[]) => call[0] === '/api/skills' && call[1]?.method === 'POST'
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(postCall![1].body)
      expect(body).not.toHaveProperty('tools_config')
      expect(body.name).toBe('Test Skill')
      expect(body.scope).toBe('container_local')
    })
  })

  // T6: create form shows scope selector for admin
  it('create form shows scope selector for admin', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Skill'))

    await waitFor(() => {
      expect(screen.getByText('New Skill')).toBeInTheDocument()
    })

    // Scope selector should be present for admin
    const scopeSelect = screen.getByDisplayValue('Container')
    expect(scopeSelect).toBeInTheDocument()
    expect(scopeSelect.tagName).toBe('SELECT')

    // All three options should be present
    const options = within(scopeSelect as HTMLElement).getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options.map((o: HTMLElement) => (o as HTMLOptionElement).value)).toEqual([
      'container_local',
      'host_docker',
      'vps_system',
    ])
  })

  // T7a: hides scope selector for non-admin
  it('hides scope selector for non-admin', async () => {
    mockSession = {
      data: { user: { name: 'User', email: 'user@hill90.com', roles: ['user'] }, expires: '2026-12-31' },
      status: 'authenticated',
    }

    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // Non-admin should not see "Add Skill" button at all
    expect(screen.queryByText('Add Skill')).not.toBeInTheDocument()
    // And no scope selector visible
    expect(screen.queryByDisplayValue('Container')).not.toBeInTheDocument()
  })

  // T8a: edit form pre-fills scope
  it('edit form pre-fills scope from skill', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Developer'))

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Edit'))

    await waitFor(() => {
      expect(screen.getByText('Edit Skill')).toBeInTheDocument()
    })

    // Developer skill has scope host_docker
    const scopeSelect = screen.getByDisplayValue('Host Docker') as HTMLSelectElement
    expect(scopeSelect).toBeInTheDocument()
    expect(scopeSelect.value).toBe('host_docker')
  })

  // T11: Nav says "Skills" with /harness/skills href inside Build group
  it('nav items include Skills entry in Build group', () => {
    const build = NAV_ITEMS.find((item) => item.type === 'group' && item.id === 'build') as NavGroup
    expect(build).toBeDefined()
    const skills = build.children.find((c) => c.id === 'skills')
    expect(skills).toBeDefined()
    expect(skills!.label).toBe('Skills')
    expect(skills!.href).toBe('/harness/skills')
  })

  // T7: Skill card shows tool dependency count badge
  it('T7: skill card shows tool dependency count', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('CI Runner')).toBeInTheDocument()
    })

    // CI Runner has 2 tools — should show "2 deps" badge
    expect(screen.getByTestId('tool-count-badge')).toHaveTextContent('2 deps')
  })

  // T8: Elevated scope shows warning indicator
  it('T8: elevated scope shows warning indicator', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('CI Runner')).toBeInTheDocument()
    })

    // CI Runner has vps_system scope, Developer has host_docker — both elevated
    const warnings = screen.getAllByTestId('elevated-warning')
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  // AI-226: Platform badge shows lock icon
  it('platform badge includes lock icon', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // Platform skills should have "Platform" badge text
    const platformBadges = screen.getAllByText('Platform')
    expect(platformBadges.length).toBeGreaterThanOrEqual(1)
  })

  // AI-226: Search input filters skills by name
  it('search input filters skills by name', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText('Search skills')
    fireEvent.change(searchInput, { target: { value: 'CI' } })

    // Only CI Runner should be visible
    expect(screen.getByText('CI Runner')).toBeInTheDocument()
    expect(screen.queryByText('Minimal')).not.toBeInTheDocument()
    expect(screen.queryByText('Developer')).not.toBeInTheDocument()
    // Count should show filtered results
    expect(screen.getByText('1 of 3 skills')).toBeInTheDocument()
  })

  // AI-226: Search with no results shows message
  it('search with no results shows empty message', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText('Search skills')
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } })

    expect(screen.getByText('No skills match your search')).toBeInTheDocument()
  })

  // AI-226: Search filters by description too
  it('search filters by description', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    const searchInput = screen.getByLabelText('Search skills')
    fireEvent.change(searchInput, { target: { value: 'health monitoring' } })

    expect(screen.getByText('Minimal')).toBeInTheDocument()
    expect(screen.queryByText('Developer')).not.toBeInTheDocument()
  })

  // AI-226: Expandable instructions — show more toggle for long instructions
  it('long instructions show "Show more" toggle', async () => {
    const skillsWithLongInstructions = [
      {
        ...MOCK_SKILLS[0],
        instructions_md: 'Line one of instructions.\nLine two of instructions.\nLine three with more detail.\nLine four with even more.',
      },
    ]
    mockFetchDefaults(skillsWithLongInstructions)

    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // Expand the skill card
    fireEvent.click(screen.getByText('Minimal'))

    await waitFor(() => {
      expect(screen.getByText(/Line one of instructions/)).toBeInTheDocument()
    })

    // Should show "Show more" since instructions have >2 lines
    expect(screen.getByText('Show more')).toBeInTheDocument()
    // Should NOT show lines 3-4 yet
    expect(screen.queryByText(/Line three with more detail/)).not.toBeInTheDocument()

    // Click "Show more"
    fireEvent.click(screen.getByText('Show more'))

    // Now all lines should be visible
    expect(screen.getByText(/Line three with more detail/)).toBeInTheDocument()
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  // AI-226: Short instructions do not show toggle
  it('short instructions do not show toggle', async () => {
    const skillsWithShortInstructions = [
      {
        ...MOCK_SKILLS[0],
        instructions_md: 'Just one line.',
      },
    ]
    mockFetchDefaults(skillsWithShortInstructions)

    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Minimal'))

    await waitFor(() => {
      expect(screen.getByText('Just one line.')).toBeInTheDocument()
    })

    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
  })
})
