import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['admin'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/monitoring',
}))

import MonitoringClient from '@/app/harness/monitoring/MonitoringClient'

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn((url: string) => {
    if (url.includes('/api/health/detailed')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.detailed ?? { uptime: 3600, version: '1.0.0' }) })
    }
    if (url.includes('/api/health')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ service: 'api', status: 'healthy' }) })
    }
    if (url.includes('/api/admin/secrets/status')) {
      return Promise.resolve({ ok: overrides.vaultOk ?? true, json: () => Promise.resolve({}) })
    }
    if (url.includes('/api/storage/buckets')) {
      return Promise.resolve({ ok: overrides.storageOk ?? true, json: () => Promise.resolve([]) })
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.agents ?? [
          { id: '1', agent_id: 'bot-1', name: 'Bot 1', status: 'running' },
          { id: '2', agent_id: 'bot-2', name: 'Bot 2', status: 'stopped' },
        ]),
      })
    }
    if (url.includes('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.usage ?? { total_requests: 42, total_cost: '1.23' }) })
    }
    if (url.includes('/api/shared-knowledge/stats')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.knowledge ?? {}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('MonitoringClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders monitoring page title', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitoring')).toBeInTheDocument()
    })
  })

  it('shows service health section', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Service Health')).toBeInTheDocument()
    })
  })

  it('shows API healthy status', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('API')).toBeInTheDocument()
      expect(screen.getAllByLabelText('healthy').length).toBeGreaterThan(0)
    })
  })

  it('shows agent overview section', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Agent Overview')).toBeInTheDocument()
    })
  })

  it('shows refresh button', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument()
    })
  })

  it('handles unhealthy vault', async () => {
    vi.stubGlobal('fetch', mockFetch({ vaultOk: false }))
    render(<MonitoringClient />)
    await waitFor(() => {
      const unhealthy = screen.getAllByLabelText('unhealthy')
      expect(unhealthy.length).toBeGreaterThan(0)
    })
  })
})
