import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AdminServicesClient from '@/app/admin/services/AdminServicesClient'

const SERVICE_NAMES = [
  'Keycloak',
  'OpenBao',
  'Grafana',
  'Portainer',
  'MinIO',
  'Traefik',
  'LiteLLM',
]

function mockHealthyResponse() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        services: SERVICE_NAMES.map((name) => ({
          name,
          status: 'healthy',
          responseTime: 20 + Math.floor(Math.random() * 30),
        })),
      }),
  })
}

function mockMixedResponse() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        services: SERVICE_NAMES.map((name, i) => ({
          name,
          status: i < 4 ? 'healthy' : 'unhealthy',
          responseTime: i < 4 ? 25 : null,
        })),
      }),
  })
}

describe('AdminServicesClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders all 7 service cards', async () => {
    mockHealthyResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      for (const name of SERVICE_NAMES) {
        expect(screen.getByText(name)).toBeInTheDocument()
      }
    })
  })

  it('renders healthy status badges when all services are healthy', async () => {
    mockHealthyResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      const healthyBadges = screen.getAllByText('Healthy')
      expect(healthyBadges.length).toBe(7)
    })
  })

  it('renders unhealthy status badges for unhealthy services', async () => {
    mockMixedResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      const healthyBadges = screen.getAllByText('Healthy')
      const unhealthyBadges = screen.getAllByText('Unhealthy')
      expect(healthyBadges.length).toBe(4)
      expect(unhealthyBadges.length).toBe(3)
    })
  })

  it('renders launch links with target="_blank"', async () => {
    mockHealthyResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      expect(screen.getByText('Keycloak')).toBeInTheDocument()
    })

    const externalLinks = screen.getAllByRole('link').filter(
      (link) => link.getAttribute('target') === '_blank'
    )
    expect(externalLinks.length).toBeGreaterThanOrEqual(7)
  })

  it('refresh button triggers re-fetch', async () => {
    mockHealthyResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    const refreshButton = screen.getByRole('button', { name: /refresh/i })
    fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  it('shows loading state initially before fetch resolves', () => {
    // Never resolve the fetch
    mockFetch.mockReturnValue(new Promise(() => {}))

    render(<AdminServicesClient />)

    const checkingIndicators = screen.getAllByText('Checking')
    expect(checkingIndicators.length).toBeGreaterThanOrEqual(1)
  })

  it('shows last checked timestamp after fetch completes', async () => {
    mockHealthyResponse()

    render(<AdminServicesClient />)

    await waitFor(() => {
      expect(screen.getByText(/last checked/i)).toBeInTheDocument()
    })
  })
})
