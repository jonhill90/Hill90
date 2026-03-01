import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth session
let mockSession: any = null

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? 'authenticated' : 'unauthenticated' }),
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
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
  },
  {
    id: 'conn-2',
    name: 'Anthropic Prod',
    provider: 'anthropic',
    api_base_url: 'https://custom.api.com',
    is_valid: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  },
]

describe('ConnectionsClient', () => {
  const session = { user: { name: 'Test', roles: ['user'] }, accessToken: 'jwt' } as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = { user: { roles: ['user'] } }
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONNECTIONS),
    })
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

    expect(screen.getByText('2 connections')).toBeInTheDocument()
  })

  it('shows validity badges', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('Valid')).toBeInTheDocument()
      expect(screen.getByText('Untested')).toBeInTheDocument()
    })
  })

  it('shows empty state when no connections', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
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
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) }) // initial fetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'new-id' }) }) // POST
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) }) // refetch

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
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) }) // initial
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'conn-1', is_valid: true }) }) // validate
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) }) // refetch

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
    // Should not have called DELETE since confirm returned false
    expect(mockFetch).toHaveBeenCalledTimes(1) // only initial fetch
    confirmSpy.mockRestore()
  })

  it('shows provider name on cards', async () => {
    render(<ConnectionsClient session={session} />)

    await waitFor(() => {
      expect(screen.getByText('openai')).toBeInTheDocument()
      expect(screen.getByText('anthropic')).toBeInTheDocument()
    })
  })
})
