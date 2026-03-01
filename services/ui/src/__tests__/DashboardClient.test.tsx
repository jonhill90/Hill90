import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import DashboardClient from '@/app/dashboard/DashboardClient'

const MOCK_SESSION = {
  user: { name: 'Admin Hill', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const MOCK_HEALTH = {
  services: [
    { name: 'API', status: 'healthy', responseTime: 42 },
    { name: 'AI', status: 'healthy', responseTime: 85 },
    { name: 'Auth', status: 'healthy', responseTime: 30 },
    { name: 'MCP', status: 'unhealthy' },
  ],
}

const MOCK_AGENTS = [
  { id: 'a1', status: 'running' },
  { id: 'a2', status: 'stopped' },
  { id: 'a3', status: 'stopped' },
  { id: 'a4', status: 'error' },
]

const MOCK_POLICIES = [
  { id: 'p1', name: 'Default Policy' },
  { id: 'p2', name: 'Restricted Policy' },
]

const MOCK_USAGE = {
  total_requests: '247',
  total_tokens: '15000',
  total_cost_usd: '0.5432',
}

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/services/health') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    }
    if (typeof url === 'string' && url.startsWith('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('DashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders session info', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    expect(screen.getByText('Admin Hill')).toBeInTheDocument()
    expect(screen.getByText('admin@hill90.com')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
  })

  it('renders harness overview with agent counts', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Harness Overview')).toBeInTheDocument()
    })

    // Total agents
    expect(screen.getByText('4')).toBeInTheDocument()
    // Status breakdown
    expect(screen.getByText('1 running')).toBeInTheDocument()
    expect(screen.getByText(/2 stopped/)).toBeInTheDocument()
  })

  it('renders harness overview with policy count', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Harness Overview')).toBeInTheDocument()
    })

    expect(screen.getByText('Policies')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders harness overview with usage totals', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Harness Overview')).toBeInTheDocument()
    })

    expect(screen.getByText('Requests (7d)')).toBeInTheDocument()
    expect(screen.getByText('247')).toBeInTheDocument()
    expect(screen.getByText('Cost (7d)')).toBeInTheDocument()
    expect(screen.getByText('$0.5432')).toBeInTheDocument()
  })

  it('renders service health cards', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('API')).toBeInTheDocument()
    })

    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByText('Auth')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
  })

  it('shows harness overview even when some fetches fail', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/services/health') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (url === '/api/model-policies') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
      }
      if (typeof url === 'string' && url.startsWith('/api/usage')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Harness Overview')).toBeInTheDocument()
    })

    // Should show 0 for everything gracefully (multiple 0s across cards)
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
  })
})
