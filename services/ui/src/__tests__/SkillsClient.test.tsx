import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have no shell or filesystem access. You can only monitor your own resource usage via the health endpoint.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-dev',
    name: 'Developer',
    description: 'Full dev environment: bash, git, make, curl, jq. Read-write workspace and data.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have full developer access with bash, git, make, curl, and jq available. Use /workspace as your primary working directory.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-custom',
    name: 'CI Runner',
    description: 'Custom preset for CI pipelines.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
    instructions_md: 'Run CI pipelines in isolated containers.',
    is_platform: false,
    created_at: '2026-02-15T00:00:00Z',
    updated_at: '2026-02-15T00:00:00Z',
  },
]

function mockFetchDefaults(skills = MOCK_SKILLS) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/skills' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(skills) })
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
    // Should show skills count, not "profiles" count
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

  // T10: Edit form pre-fills instructions_md
  it('edit form pre-fills instructions_md', async () => {
    render(<SkillsClient />)

    await waitFor(() => {
      expect(screen.getByText('CI Runner')).toBeInTheDocument()
    })

    // Expand CI Runner (non-platform, has Edit button)
    fireEvent.click(screen.getByText('CI Runner'))

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Edit'))

    await waitFor(() => {
      expect(screen.getByText('Edit Skill')).toBeInTheDocument()
    })

    // Instructions textarea should be pre-filled
    const instructionsTextarea = screen.getByPlaceholderText(/behavioral instructions/i) as HTMLTextAreaElement
    expect(instructionsTextarea.value).toBe('Run CI pipelines in isolated containers.')
  })

  // T11: Nav says "Skills" with /harness/skills href
  it('nav items include Skills entry', () => {
    const harness = NAV_ITEMS.find((item) => item.type === 'group' && item.id === 'harness') as NavGroup
    expect(harness).toBeDefined()
    const skills = harness.children.find((c) => c.id === 'skills')
    expect(skills).toBeDefined()
    expect(skills!.label).toBe('Skills')
    expect(skills!.href).toBe('/harness/skills')
  })
})
