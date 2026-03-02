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

import ToolProfilesClient from '@/app/harness/tool-profiles/ToolProfilesClient'
import { NAV_ITEMS, type NavGroup } from '@/components/nav-items'

const MOCK_PRESETS = [
  {
    id: 'preset-minimal',
    name: 'Minimal',
    description: 'Health monitoring only. No shell or filesystem access.',
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
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
    is_platform: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-research',
    name: 'Research',
    description: 'Read-only with networking tools.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'curl', 'wget', 'jq'], denied_patterns: ['rm ', 'mv ', 'dd ', 'mkfs', '> /', '>> /'], max_timeout: 120 },
      filesystem: { enabled: true, read_only: true, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    is_platform: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'preset-operator',
    name: 'Operator',
    description: 'All pre-installed tools including rsync and ssh.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'curl', 'wget', 'jq', 'rsync', 'ssh', 'make', 'vim'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data', '/var/log/agentbox'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
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
    is_platform: false,
    created_at: '2026-02-15T00:00:00Z',
    updated_at: '2026-02-15T00:00:00Z',
  },
]

function mockFetchDefaults(presets = MOCK_PRESETS) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/tool-presets' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(presets) })
    }
    if (url === '/api/tool-presets' && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-preset', ...JSON.parse(opts.body) }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/tool-presets/') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('ToolProfilesClient', () => {
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

  // T24: Tool Profiles page lists presets
  it('renders preset list with names and descriptions', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('Operator')).toBeInTheDocument()
    expect(screen.getByText('CI Runner')).toBeInTheDocument()
    expect(screen.getByText('5 profiles')).toBeInTheDocument()
  })

  // T25: Platform presets show Platform badge
  it('platform presets show Platform badge', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    const platformBadges = screen.getAllByText('Platform')
    expect(platformBadges).toHaveLength(4)
  })

  // T26: Expanding preset shows tools_config detail
  it('expanding preset shows tools_config detail', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Click Developer row to expand
    fireEvent.click(screen.getByText('Developer'))

    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument()
    })
    expect(screen.getByText('git')).toBeInTheDocument()
    expect(screen.getByText('make')).toBeInTheDocument()
    expect(screen.getByText('curl')).toBeInTheDocument()
    expect(screen.getByText('jq')).toBeInTheDocument()
    expect(screen.getByText('/workspace')).toBeInTheDocument()
    expect(screen.getByText('/data')).toBeInTheDocument()
  })

  // T27: Admin can create new preset
  it('admin can create new preset via form', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Profile'))

    expect(screen.getByText('New Tool Profile')).toBeInTheDocument()

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('Profile name'), { target: { value: 'Test Profile' } })

    // Fill description
    fireEvent.change(screen.getByPlaceholderText('Brief description'), { target: { value: 'A test' } })

    // Enable shell
    fireEvent.click(screen.getByLabelText('Shell'))

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/tool-presets', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"Test Profile"'),
      }))
    })
  })

  // T28: Nav includes Tool Profiles
  // Tested separately in nav-items unit test below

  // Additional: non-admin cannot see create/delete
  it('hides create button and delete for non-admin', async () => {
    mockSession = {
      data: { user: { name: 'User', email: 'user@hill90.com', roles: ['user'] }, expires: '2026-12-31' },
      status: 'authenticated',
    }

    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    expect(screen.queryByText('Add Profile')).not.toBeInTheDocument()
  })

  // Platform presets show no edit/delete in expanded view
  it('platform presets have no edit or delete buttons', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    // Expand a platform preset
    fireEvent.click(screen.getByText('Minimal'))

    // Description appears in both summary (truncated) and expanded detail
    await waitFor(() => {
      const descriptions = screen.getAllByText('Health monitoring only. No shell or filesystem access.')
      expect(descriptions.length).toBeGreaterThanOrEqual(2)
    })

    // Should not have edit/delete buttons for platform preset
    // The expanded section is the div with border-t class
    const expandedSections = document.querySelectorAll('div[class*="border-t"]')
    const expandedSection = expandedSections[0]
    expect(expandedSection?.querySelector('button')).toBeNull()
  })

  // Admin-created presets show edit/delete
  it('admin-created presets show delete button', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('CI Runner')).toBeInTheDocument()
    })

    // Expand admin-created preset
    fireEvent.click(screen.getByText('CI Runner'))

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })
  })

  // T28: Nav includes Tool Profiles in Harness group
  it('NAV_ITEMS includes Tool Profiles in Harness group', () => {
    const harness = NAV_ITEMS.find((item) => item.type === 'group' && item.id === 'harness') as NavGroup
    expect(harness).toBeDefined()
    const toolProfiles = harness.children.find((c) => c.id === 'tool-profiles')
    expect(toolProfiles).toBeDefined()
    expect(toolProfiles!.label).toBe('Tool Profiles')
    expect(toolProfiles!.href).toBe('/harness/tool-profiles')
  })

  // Tool summary badges on rows
  it('shows tool summary badges on preset rows', async () => {
    render(<ToolProfilesClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Developer has shell + filesystem + health — should show badges
    const shellBadges = screen.getAllByText('Shell')
    expect(shellBadges.length).toBeGreaterThanOrEqual(1)

    const fsBadges = screen.getAllByText('Filesystem')
    expect(fsBadges.length).toBeGreaterThanOrEqual(1)
  })
})
