import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import ModelsClient from '@/app/harness/models/ModelsClient'

const MOCK_CONNECTIONS = [
  { id: 'conn-1', name: 'My OpenAI Key', provider: 'openai' },
  { id: 'conn-2', name: 'Anthropic Prod', provider: 'anthropic' },
]

const MOCK_MODELS = [
  {
    id: 'model-1',
    name: 'GPT-4o Mini',
    connection_id: 'conn-1',
    litellm_model: 'gpt-4o-mini',
    description: 'Fast and cheap',
    is_active: true,
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
  },
  {
    id: 'model-2',
    name: 'Claude Sonnet',
    connection_id: 'conn-2',
    litellm_model: 'claude-sonnet-4-5-20250929',
    description: '',
    is_active: true,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  },
]

function mockFetchResponses(models = MOCK_MODELS, connections = MOCK_CONNECTIONS) {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/user-models') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(models) })
    }
    if (url === '/api/provider-connections') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(connections) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('ModelsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchResponses()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders model table with connection names', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
      expect(screen.getByText('Claude Sonnet')).toBeInTheDocument()
    })

    expect(screen.getByText('2 models')).toBeInTheDocument()
    expect(screen.getByText('My OpenAI Key')).toBeInTheDocument()
    expect(screen.getByText('Anthropic Prod')).toBeInTheDocument()
  })

  it('shows provider model IDs', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
      expect(screen.getByText('claude-sonnet-4-5-20250929')).toBeInTheDocument()
    })
  })

  it('shows empty state when no models', async () => {
    mockFetchResponses([], MOCK_CONNECTIONS)

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('No models defined yet')).toBeInTheDocument()
      expect(screen.getByText('Create a model to use with your provider connections.')).toBeInTheDocument()
    })
  })

  it('shows connection-first hint when no connections exist', async () => {
    mockFetchResponses([], [])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('Create a provider connection first, then add models.')).toBeInTheDocument()
    })
  })

  it('disables Add Model when no connections', async () => {
    mockFetchResponses([], [])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('No models defined yet')).toBeInTheDocument()
    })

    const addButton = screen.getByText('Add Model')
    expect(addButton).toBeDisabled()
  })

  it('opens create form with connection dropdown', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    expect(screen.getByText('New Model')).toBeInTheDocument()
    expect(screen.getByText('Select a connection')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('GPT-4o Mini')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('gpt-4o-mini')).toBeInTheDocument()
  })

  it('submits create form with correct body', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    fireEvent.change(screen.getByPlaceholderText('GPT-4o Mini'), { target: { value: 'New Model' } })
    fireEvent.change(screen.getByPlaceholderText('gpt-4o-mini'), { target: { value: 'gpt-4o' } })

    // Select connection
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/user-models', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"New Model"'),
      }))
    })
  })

  it('confirms before deleting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    const deleteButtons = screen.getAllByText('Delete')
    fireEvent.click(deleteButtons[0])

    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
