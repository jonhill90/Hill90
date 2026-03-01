import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import PoliciesClient from '@/app/harness/policies/PoliciesClient'

const MOCK_USER_MODELS = [
  { id: 'model-1', name: 'GPT-4o Mini', litellm_model: 'gpt-4o-mini' },
  { id: 'model-2', name: 'Claude Sonnet', litellm_model: 'claude-sonnet-4-5-20250929' },
]

const MOCK_POLICIES = [
  {
    id: 'policy-1',
    name: 'Default Policy',
    description: 'Standard access',
    allowed_models: ['GPT-4o Mini', 'Claude Sonnet'],
    max_requests_per_minute: 60,
    max_tokens_per_day: 1000000,
    model_aliases: { fast: 'GPT-4o Mini' },
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'policy-2',
    name: 'Budget Policy',
    description: '',
    allowed_models: ['GPT-4o Mini'],
    max_requests_per_minute: null,
    max_tokens_per_day: 100000,
    model_aliases: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    created_by: 'user',
  },
]

function mockFetchResponses(policies = MOCK_POLICIES, models = MOCK_USER_MODELS) {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(policies) })
    }
    if (url === '/api/user-models') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(models) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('PoliciesClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchResponses()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders policy rows with model chips', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
      expect(screen.getByText('Budget Policy')).toBeInTheDocument()
    })

    expect(screen.getByText('2 policies')).toBeInTheDocument()

    // Model chips shown in summary row (first 3 models shown)
    const gptChips = screen.getAllByText('GPT-4o Mini')
    expect(gptChips.length).toBeGreaterThanOrEqual(2) // in both policy rows
  })

  it('shows rate limit and token budget in summary', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('60 req/min')).toBeInTheDocument()
      expect(screen.getByText('1,000,000 tok/day')).toBeInTheDocument()
      expect(screen.getByText('No rate limit')).toBeInTheDocument()
      expect(screen.getByText('100,000 tok/day')).toBeInTheDocument()
    })
  })

  it('shows empty state when no policies', async () => {
    mockFetchResponses([], MOCK_USER_MODELS)

    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('No model policies yet')).toBeInTheDocument()
      expect(screen.getByText('Create a policy to control which models your agents can access.')).toBeInTheDocument()
    })
  })

  it('expands policy to show detail', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    // Click the Default Policy row to expand it
    fireEvent.click(screen.getByText('Default Policy'))

    // Should show description, full allowed models, and aliases
    await waitFor(() => {
      expect(screen.getByText('Standard access')).toBeInTheDocument()
      expect(screen.getByText('Model Aliases')).toBeInTheDocument()
      expect(screen.getByText('fast')).toBeInTheDocument()
    })
  })

  it('shows model alias mapping in expanded detail', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Default Policy'))

    await waitFor(() => {
      // Alias: fast → GPT-4o Mini
      expect(screen.getByText('fast')).toBeInTheDocument()
    })
  })

  it('opens create form with model multi-select', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Policy'))

    expect(screen.getByText('New Policy')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Agent Default Policy')).toBeInTheDocument()

    // Model toggle buttons from user models
    const modelButtons = screen.getAllByText('GPT-4o Mini')
    expect(modelButtons.length).toBeGreaterThanOrEqual(1)
  })

  it('toggles model selection in create form', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Policy'))

    // Find the toggle buttons in the form (Allowed Models section)
    const formSection = screen.getByText('Allowed Models').parentElement!
    const gptButton = formSection.querySelector('button')!
    expect(gptButton).toBeInTheDocument()

    // Click to select — should get brand styling
    fireEvent.click(gptButton)
    expect(gptButton.className).toContain('brand')

    // Click again to deselect
    fireEvent.click(gptButton)
    expect(gptButton.className).not.toContain('bg-brand')
  })

  it('submits create form with correct body', async () => {
    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Policy'))

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('Agent Default Policy'), { target: { value: 'Test Policy' } })

    // Select a model
    const formSection = screen.getByText('Allowed Models').parentElement!
    const gptButton = formSection.querySelector('button')!
    fireEvent.click(gptButton)

    // Set rate limit
    fireEvent.change(screen.getByPlaceholderText('60'), { target: { value: '30' } })

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/model-policies', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"Test Policy"'),
      }))
    })
  })

  it('confirms before deleting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<PoliciesClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    // Expand to see delete button
    fireEvent.click(screen.getByText('Default Policy'))

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Delete'))

    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
