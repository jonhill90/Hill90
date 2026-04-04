import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

let mockSession: any = {
  data: { user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] }, expires: '2026-12-31' },
  status: 'authenticated',
}

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.stubGlobal('confirm', vi.fn(() => true))
vi.stubGlobal('alert', vi.fn())

import ToolsClient from '@/app/harness/tools/ToolsClient'
import { NAV_ITEMS, type NavGroup } from '@/components/nav-items'

const MOCK_TOOLS = [
  {
    id: 'tool-bash',
    name: 'bash',
    description: 'Shell',
    install_method: 'builtin',
    install_ref: '',
    is_platform: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'tool-gh',
    name: 'gh',
    description: 'GitHub CLI',
    install_method: 'binary',
    install_ref: 'https://github.com/cli/cli',
    is_platform: false,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/tools' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOLS) })
    }
    if (url === '/api/tools' && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'tool-new', ...JSON.parse(opts.body) }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/tools/') && opts?.method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: url.split('/').pop(), ...JSON.parse(opts.body) }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/tools/') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('ToolsClient', () => {
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

  it('shows Dependencies page title and fetched tools', async () => {
    render(<ToolsClient />)

    await waitFor(() => {
      expect(screen.getByText('Dependencies')).toBeInTheDocument()
    })

    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('gh')).toBeInTheDocument()
    expect(screen.getByText('Builtin')).toBeInTheDocument()
    expect(screen.getByText('Binary')).toBeInTheDocument()
  })

  it('T6: renders dependency catalog subtitle', async () => {
    render(<ToolsClient />)

    await waitFor(() => {
      expect(screen.getByText('Dependencies')).toBeInTheDocument()
    })

    expect(screen.getByText('CLI tools and packages available to agent skills.')).toBeInTheDocument()
  })

  it('allows editing seeded tools', async () => {
    render(<ToolsClient />)

    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByText('Edit')[0])

    await waitFor(() => {
      expect(screen.getByText('Edit Tool')).toBeInTheDocument()
    })

    const nameInput = screen.getByPlaceholderText('gh') as HTMLInputElement
    expect(nameInput.value).toBe('bash')
  })

  it('create form can add a tool', async () => {
    render(<ToolsClient />)

    await waitFor(() => {
      expect(screen.getByText('Add Tool')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Tool'))
    fireEvent.change(screen.getByPlaceholderText('gh'), { target: { value: 'docker' } })
    fireEvent.change(screen.getByPlaceholderText('GitHub CLI'), { target: { value: 'Docker CLI' } })
    fireEvent.change(screen.getByDisplayValue('Builtin'), { target: { value: 'binary' } })
    fireEvent.change(screen.getByPlaceholderText('Package name or download URL'), { target: { value: 'https://download.docker.com/' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/tools', expect.objectContaining({
        method: 'POST',
      }))
    })
  })

  it('nav items include Dependencies entry', () => {
    const harness = NAV_ITEMS.find((item) => item.type === 'group' && item.id === 'harness') as NavGroup
    expect(harness).toBeDefined()
    const deps = harness.children.find((c) => c.id === 'dependencies')
    expect(deps).toBeDefined()
    expect(deps!.label).toBe('Dependencies')
    expect(deps!.href).toBe('/harness/tools')
    expect(deps!.adminOnly).toBe(true)
  })
})
