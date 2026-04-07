import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth session
let mockSession: any = null

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? 'authenticated' : 'unauthenticated' }),
}))

// Mock provider-icons to avoid SVG rendering complexity
vi.mock('../app/harness/models/provider-icons', () => ({
  ProviderIcon: ({ provider, className }: { provider: string; className?: string }) => (
    <span data-testid={`provider-icon-${provider}`} className={className}>{provider}</span>
  ),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import ConnectionsClient from '@/app/harness/connections/ConnectionsClient'

const MOCK_CONNECTIONS = [
  {
    id: 'conn-1',
    name: 'My OpenAI Key',
    provider: 'openai',
    api_base_url: null,
    is_valid: true,
    last_validated_at: '2026-04-01T12:00:00Z',
    last_validation_error: null,
    validation_latency_ms: 245,
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-04-01T12:00:00Z',
  },
  {
    id: 'conn-2',
    name: 'Anthropic Prod',
    provider: 'anthropic',
    api_base_url: 'https://custom.api.com',
    is_valid: false,
    last_validated_at: '2026-03-30T08:00:00Z',
    last_validation_error: 'Invalid API key',
    validation_latency_ms: 180,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-03-30T08:00:00Z',
  },
  {
    id: 'conn-3',
    name: 'Untested Key',
    provider: 'openai',
    api_base_url: null,
    is_valid: null,
    last_validated_at: null,
    last_validation_error: null,
    validation_latency_ms: null,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
  },
]

const MOCK_HEALTH = {
  total: 3,
  valid: 1,
  invalid: 1,
  untested: 1,
  avg_latency_ms: 213,
  by_provider: [
    { provider: 'anthropic', total: 1, valid: 0, invalid: 1, untested: 0, avg_latency_ms: 180 },
    { provider: 'openai', total: 2, valid: 1, invalid: 0, untested: 1, avg_latency_ms: 245 },
  ],
}

const MOCK_MODELS = [
  { id: 'model-1', connection_id: 'conn-1' },
  { id: 'model-2', connection_id: 'conn-1' },
  { id: 'model-3', connection_id: 'conn-2' },
]

function mockFetchForAll() {
  mockFetch.mockImplementation((...args: any[]) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
    if (url.includes('/health')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
    }
    if (url.includes('/user-models')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
    }
    if (url.includes('/provider-connections')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
  })
}

describe('ConnectionsClient', () => {
  const session = { user: { name: 'Test', roles: ['user'] }, accessToken: 'jwt' } as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = { user: { roles: ['user'] } }
    mockFetchForAll()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders connection cards after loading', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
      expect(screen.getByText('Anthropic Prod')).toBeInTheDocument()
    })

    expect(screen.getByText('3 connections')).toBeInTheDocument()
  })

  it('shows validity badges', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Valid')).toBeInTheDocument()
      expect(screen.getByText('Untested')).toBeInTheDocument()
    })
  })

  it('shows empty state when no connections', async () => {
    mockFetch.mockImplementation((...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
      if (url.includes('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ total: 0, valid: 0, invalid: 0, untested: 0, avg_latency_ms: null, by_provider: [] }) })
      }
      if (url.includes('/user-models')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })

    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('No provider connections yet')).toBeInTheDocument()
      expect(screen.getByText('Add your first API key to get started')).toBeInTheDocument()
    })
  })

  it('opens create form when Add Connection clicked', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Connection'))

    expect(screen.getByText('New Connection')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('My OpenAI Key')).toBeInTheDocument()
  })

  it('submits create form', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Connection'))

    const nameInput = screen.getByPlaceholderText('My OpenAI Key')
    fireEvent.change(nameInput, { target: { value: 'New Key' } })

    const keyInput = screen.getByPlaceholderText('sk-...')
    fireEvent.change(keyInput, { target: { value: 'sk-test123' } })

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/provider-connections', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"New Key"'),
      }))
    })
  })

  it('calls validate endpoint on Test click', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    const testButtons = screen.getAllByText('Test')
    fireEvent.click(testButtons[0])

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/provider-connections/conn-1/validate', expect.objectContaining({
        method: 'POST',
      }))
    })
  })

  it('confirms before deleting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    const deleteButtons = screen.getAllByText('Delete')
    fireEvent.click(deleteButtons[0])

    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('shows provider icons on cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-icon-openai').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByTestId('provider-icon-anthropic').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows Check All button when connections exist', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Check All')).toBeInTheDocument()
    })
  })

  it('Check All triggers validate-all endpoint', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Check All')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Check All'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/provider-connections/validate-all', expect.objectContaining({
        method: 'POST',
      }))
    })
  })

  it('shows tabs for Connections and Health', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Connections')).toBeInTheDocument()
      expect(screen.getByText('Health')).toBeInTheDocument()
    })
  })

  it('shows validation latency on connection cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText(/245ms/)).toBeInTheDocument()
    })
  })

  it('shows last validation error on connection cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Invalid API key')).toBeInTheDocument()
    })
  })

  it('shows health dots on connection cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByTestId('health-dot-valid')).toBeInTheDocument()
      expect(screen.getByTestId('health-dot-invalid')).toBeInTheDocument()
      expect(screen.getByTestId('health-dot-unknown')).toBeInTheDocument()
    })
  })

  it('shows model count per connection', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByTestId('model-count-conn-1')).toHaveTextContent('2 models')
      expect(screen.getByTestId('model-count-conn-2')).toHaveTextContent('1 model')
      expect(screen.getByTestId('model-count-conn-3')).toHaveTextContent('0 models')
    })
  })

  it('shows health summary in header', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('1 healthy')).toBeInTheDocument()
      expect(screen.getByText(/1 failing/)).toBeInTheDocument()
    })
  })

  it('fetches health on page load', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    // Health should be fetched on mount (not just on health tab)
    const healthCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/health')
    )
    expect(healthCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('auto-refreshes health every 60 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    const initialHealthCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/health')
    ).length
    expect(initialHealthCalls).toBe(1)

    // Advance timer by 60s
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    await waitFor(() => {
      const afterCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/health')
      ).length
      expect(afterCalls).toBe(2)
    })

    vi.useRealTimers()
  })
})

describe('ConnectionsClient Health Tab', () => {
  const session = { user: { name: 'Test', roles: ['user'] }, accessToken: 'jwt' } as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = { user: { roles: ['user'] } }
    mockFetchForAll()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders health summary cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Health'))

    await waitFor(() => {
      expect(screen.getByText('Connection Details')).toBeInTheDocument()
      expect(screen.getByText('By Provider')).toBeInTheDocument()
      expect(screen.getByText('213ms')).toBeInTheDocument()
    })
  })

  it('renders per-connection health table', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Health'))

    await waitFor(() => {
      expect(screen.getByText('Connection Details')).toBeInTheDocument()
      expect(screen.getByText('By Provider')).toBeInTheDocument()
    })
  })

  it('displays latency for validated connections', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Health'))

    await waitFor(() => {
      expect(screen.getByText('213ms')).toBeInTheDocument() // avg latency
    })
  })

  it('shows empty state when no connections', async () => {
    const emptyHealth = { total: 0, valid: 0, invalid: 0, untested: 0, avg_latency_ms: null, by_provider: [] }
    mockFetch.mockImplementation((...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
      if (url.includes('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyHealth) })
      }
      if (url.includes('/user-models')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })

    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('No provider connections yet')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Health'))

    await waitFor(() => {
      expect(screen.getByText('No connections to monitor')).toBeInTheDocument()
    })
  })

  it('shows provider icons in health table', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Health'))

    await waitFor(() => {
      expect(screen.getByText('Connection Details')).toBeInTheDocument()
      // Provider icons should be present in the health table
      const icons = screen.getAllByTestId(/provider-icon-/)
      expect(icons.length).toBeGreaterThan(0)
    })
  })
})
