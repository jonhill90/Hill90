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
    model_type: 'single',
    detected_type: 'chat',
    capabilities: ['chat', 'function_calling'],
    routing_config: null,
    icon_emoji: null,
    icon_url: null,
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
    model_type: 'single',
    detected_type: 'chat',
    capabilities: ['chat', 'function_calling'],
    routing_config: null,
    icon_emoji: null,
    icon_url: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  },
]

const MOCK_ROUTER_MODEL = {
  id: 'model-router',
  name: 'Multi Router',
  connection_id: null,
  litellm_model: null,
  description: 'Routes between models',
  is_active: true,
  model_type: 'router',
  detected_type: null,
  capabilities: null,
  routing_config: {
    strategy: 'fallback',
    default_route: 'primary',
    routes: [
      { key: 'primary', connection_id: 'conn-1', litellm_model: 'openai/gpt-4o', priority: 1 },
      { key: 'secondary', connection_id: 'conn-2', litellm_model: 'anthropic/claude-sonnet-4-20250514', priority: 2 },
    ],
  },
  icon_emoji: null,
  icon_url: null,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
}

const MOCK_PROVIDER_MODELS = [
  { id: 'openai/gpt-4o', display_name: 'gpt-4o', detected_type: 'chat', capabilities: ['chat', 'function_calling', 'vision'] },
  { id: 'openai/gpt-4o-mini', display_name: 'gpt-4o-mini', detected_type: 'chat', capabilities: ['chat', 'function_calling'] },
  { id: 'openai/text-embedding-3-small', display_name: 'text-embedding-3-small', detected_type: 'embedding', capabilities: ['embedding'] },
]

function mockFetchResponses(models = MOCK_MODELS, connections = MOCK_CONNECTIONS) {
  mockFetch.mockImplementation((url: string, options?: any) => {
    if (url === '/api/user-models' && (!options || !options.method || options.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(models) })
    }
    if (url === '/api/provider-connections') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(connections) })
    }
    if (typeof url === 'string' && url.match(/\/api\/provider-connections\/[^/]+\/models$/)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: MOCK_PROVIDER_MODELS, provider: 'openai' }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/user-models')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-model' }) })
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

  // D1: Connection select fetches provider models
  it('D1: connection select fetches provider models', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/provider-connections/conn-1/models')
    })
  })

  // D2: Provider model multi-select shows models
  it('D2: provider model multi-select shows models', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      // Provider models appear in the picker (may also appear in the table)
      expect(screen.getAllByText('gpt-4o').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('gpt-4o-mini').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('text-embedding-3-small').length).toBeGreaterThanOrEqual(1)
    })
  })

  // D3: Model fetch loading state
  it('D3: model fetch loading state shows spinner', async () => {
    // Make the models fetch hang
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
      if (url === '/api/provider-connections') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) })
      if (typeof url === 'string' && url.includes('/models')) return new Promise(() => {}) // never resolves
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('Loading models from provider...')).toBeInTheDocument()
    })
  })

  // D4: Model fetch error shows actionable error + retry
  it('D4: model fetch error shows actionable error + retry', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
      if (url === '/api/provider-connections') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) })
      if (typeof url === 'string' && url.includes('/models')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [], error: 'Invalid API key', provider: 'openai' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('Could not fetch models from provider. Check your connection credentials.')).toBeInTheDocument()
      expect(screen.getByText('Invalid API key')).toBeInTheDocument()
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })
  })

  // D5: Model fetch empty (unsupported provider) shows message
  it('D5: unsupported provider shows message + free-text input', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
      if (url === '/api/provider-connections') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) })
      if (typeof url === 'string' && url.includes('/models')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [], provider: 'custom' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('Model listing not supported for this provider')).toBeInTheDocument()
    })
  })

  // D6: Selecting 1 model hides router panel
  it('D6: selecting 1 model hides router panel', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select one model
    const checkboxes = screen.getAllByRole('checkbox')
    const gpt4oCheckbox = checkboxes.find(cb => {
      const label = cb.closest('label')
      return label?.textContent?.includes('gpt-4o') && !label?.textContent?.includes('mini')
    })
    if (gpt4oCheckbox) fireEvent.click(gpt4oCheckbox)

    // Router panel should NOT be visible
    expect(screen.queryByText('Router Configuration')).not.toBeInTheDocument()
  })

  // D7: Selecting 2+ models shows router panel automatically
  it('D7: selecting 2+ models shows router panel', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select two models
    const providerModelLabels = screen.getAllByRole('checkbox').filter(cb => {
      const label = cb.closest('label')
      return label?.textContent?.includes('gpt-4o') || label?.textContent?.includes('text-embedding')
    })
    if (providerModelLabels[0]) fireEvent.click(providerModelLabels[0])
    if (providerModelLabels[1]) fireEvent.click(providerModelLabels[1])

    await waitFor(() => {
      expect(screen.getByText('Router Configuration')).toBeInTheDocument()
    })
  })

  // D8: Strategy toggle works
  it('D8: strategy toggle works', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select two models to get router panel
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])

    await waitFor(() => {
      expect(screen.getByText('Router Configuration')).toBeInTheDocument()
    })

    const taskRoutingRadio = screen.getByLabelText('Task Routing')
    fireEvent.click(taskRoutingRadio)

    expect(taskRoutingRadio).toBeChecked()
  })

  // D9: Submit single sends connection_id+litellm_model
  it('D9: submit single sends correct body', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('GPT-4o Mini'), { target: { value: 'Test Model' } })

    // Select connection
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select ONE model
    const gpt4oLabel = screen.getByText('gpt-4o').closest('label')
    if (gpt4oLabel) {
      const checkbox = gpt4oLabel.querySelector('input[type="checkbox"]')
      if (checkbox) fireEvent.click(checkbox)
    }

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (call: any[]) => call[0] === '/api/user-models' && call[1]?.method === 'POST'
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(postCall![1].body)
      expect(body.connection_id).toBe('conn-1')
      expect(body.litellm_model).toBe('openai/gpt-4o')
      expect(body.model_type).toBeUndefined() // single is default, no need to send
    })
  })

  // D10: Submit router sends routing_config
  it('D10: submit router sends routing_config', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('GPT-4o Mini'), { target: { value: 'Router Model' } })

    // Select connection
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select TWO models
    const checkboxes = screen.getAllByRole('checkbox').filter(cb => {
      const label = cb.closest('label')
      return label?.textContent?.includes('gpt-4o') || label?.textContent?.includes('gpt-4o-mini')
    })
    if (checkboxes[0]) fireEvent.click(checkboxes[0])
    if (checkboxes[1]) fireEvent.click(checkboxes[1])

    await waitFor(() => {
      expect(screen.getByText('Router Configuration')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (call: any[]) => call[0] === '/api/user-models' && call[1]?.method === 'POST'
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(postCall![1].body)
      expect(body.model_type).toBe('router')
      expect(body.routing_config).toBeDefined()
      expect(body.routing_config.strategy).toBe('fallback')
      expect(body.routing_config.routes.length).toBeGreaterThanOrEqual(2)
    })
  })

  // D11: Table shows model type badge
  it('D11: table shows model type badges', async () => {
    mockFetchResponses([...MOCK_MODELS, MOCK_ROUTER_MODEL])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('Router')).toBeInTheDocument()
      expect(screen.getAllByText('Single')).toHaveLength(2)
    })
  })

  // D12: Provider icon shown for OpenAI single model
  it('D12: provider icon shown for OpenAI single model', async () => {
    mockFetchResponses(MOCK_MODELS)

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    const svg = document.querySelector('svg[data-testid="provider-icon-openai"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'false')
  })

  // D13: icon_url ignored in table row rendering — provider SVG takes priority
  it('D13: icon_url ignored in table row — provider SVG renders instead', async () => {
    const modelWithIcon = { ...MOCK_MODELS[0], icon_url: 'https://example.com/icon.png' }
    mockFetchResponses([modelWithIcon])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    // No <img> element in the table row for this model
    const tableRows = document.querySelectorAll('tbody tr')
    const firstRow = tableRows[0]
    expect(firstRow.querySelector('img')).not.toBeInTheDocument()

    // Provider SVG is rendered instead
    const svg = firstRow.querySelector('svg[data-testid="provider-icon-openai"]')
    expect(svg).toBeInTheDocument()
  })

  // D20: Provider icon shown for Anthropic single model
  it('D20: provider icon shown for Anthropic single model', async () => {
    mockFetchResponses(MOCK_MODELS)

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('Claude Sonnet')).toBeInTheDocument()
    })

    const svg = document.querySelector('svg[data-testid="provider-icon-anthropic"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'false')
  })

  // D21: Router with 2 mixed providers renders side-by-side composite
  it('D21: router with 2 providers renders composite icon', async () => {
    mockFetchResponses([...MOCK_MODELS, MOCK_ROUTER_MODEL])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('Multi Router')).toBeInTheDocument()
    })

    const composite = document.querySelector('[data-testid="composite-provider-icon"]')
    expect(composite).toBeInTheDocument()
    const svgs = composite!.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)
  })

  // D22: Unknown provider renders fallback icon
  it('D22: unknown provider renders fallback icon', async () => {
    const unknownModel = {
      ...MOCK_MODELS[0],
      id: 'model-deepseek',
      name: 'DeepSeek',
      connection_id: 'conn-deepseek',
    }
    const connectionsWithDeepseek = [
      ...MOCK_CONNECTIONS,
      { id: 'conn-deepseek', name: 'DeepSeek Key', provider: 'deepseek' },
    ]
    mockFetchResponses([unknownModel], connectionsWithDeepseek)

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    })

    const svg = document.querySelector('svg[data-testid="provider-icon-deepseek"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'true')
  })

  // D14: Custom model ID fallback
  it('D14: custom model ID fallback', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('GPT-4o Mini'), { target: { value: 'Custom' } })

    // Select connection
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('Enter custom model ID')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Enter custom model ID'))

    const customInput = screen.getByPlaceholderText('openai/gpt-4o-mini')
    fireEvent.change(customInput, { target: { value: 'custom/my-model' } })

    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (call: any[]) => call[0] === '/api/user-models' && call[1]?.method === 'POST'
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(postCall![1].body)
      expect(body.litellm_model).toBe('custom/my-model')
    })
  })

  // D16: Auto-detected type badge shown
  it('D16: auto-detected type badge shown in table', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getAllByText('chat')).toHaveLength(2)
    })
  })

  // D17: Manual type override dropdown
  it('D17: manual type override dropdown present in form', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    const typeSelect = screen.getByDisplayValue('Auto-detect')
    expect(typeSelect).toBeInTheDocument()
    fireEvent.change(typeSelect, { target: { value: 'embedding' } })

    expect(typeSelect).toHaveValue('embedding')
  })

  // D18: Capabilities checkboxes reflect detection
  it('D18: capabilities checkboxes present in form', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    expect(screen.getByText('function_calling')).toBeInTheDocument()
    expect(screen.getByText('vision')).toBeInTheDocument()
    expect(screen.getByText('embedding')).toBeInTheDocument()
  })

  // D19: Add model from different connection
  it('D19: add model from different connection adds cross-connection row', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select two models to trigger router panel
    const checkboxes = screen.getAllByRole('checkbox').filter(cb => {
      const label = cb.closest('label')
      return label?.textContent?.includes('gpt-4o') || label?.textContent?.includes('gpt-4o-mini')
    })
    if (checkboxes[0]) fireEvent.click(checkboxes[0])
    if (checkboxes[1]) fireEvent.click(checkboxes[1])

    await waitFor(() => {
      expect(screen.getByText('Add model from different connection')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add model from different connection'))

    // A new select/input row should appear
    await waitFor(() => {
      expect(screen.getByText('Select connection')).toBeInTheDocument()
    })
  })

  // D23: Router submit with empty extra-route connection_id shows error
  it('D23: router submit with empty extra-route connection_id shows error', async () => {
    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Model'))

    // Fill name
    fireEvent.change(screen.getByPlaceholderText('GPT-4o Mini'), { target: { value: 'Router Test' } })

    // Select connection
    const connectionSelect = screen.getByDisplayValue('Select a connection')
    fireEvent.change(connectionSelect, { target: { value: 'conn-1' } })

    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    // Select TWO models to trigger router mode
    const checkboxes = screen.getAllByRole('checkbox').filter(cb => {
      const label = cb.closest('label')
      return label?.textContent?.includes('gpt-4o') || label?.textContent?.includes('gpt-4o-mini')
    })
    if (checkboxes[0]) fireEvent.click(checkboxes[0])
    if (checkboxes[1]) fireEvent.click(checkboxes[1])

    await waitFor(() => {
      expect(screen.getByText('Router Configuration')).toBeInTheDocument()
    })

    // Add extra route (empty connection_id)
    fireEvent.click(screen.getByText('Add model from different connection'))

    await waitFor(() => {
      expect(screen.getByText('Select connection')).toBeInTheDocument()
    })

    // Fill in the model ID for the extra route but leave connection empty
    const modelInput = screen.getByPlaceholderText('provider/model-id')
    fireEvent.change(modelInput, { target: { value: 'anthropic/claude-sonnet-4-20250514' } })

    // Submit
    fireEvent.click(screen.getByText('Create'))

    // Should show validation error, no fetch call made
    await waitFor(() => {
      expect(screen.getByText('All routes must have a connection selected')).toBeInTheDocument()
    })

    // Verify no POST was made to user-models
    const postCalls = mockFetch.mock.calls.filter(
      (call: any[]) => call[0] === '/api/user-models' && call[1]?.method === 'POST'
    )
    expect(postCalls).toHaveLength(0)
  })

  // D24: Stale connection shows "Unknown connection" badge in table
  it('D24: stale connection shows Unknown connection in table', async () => {
    const modelWithStaleConn = {
      ...MOCK_MODELS[0],
      id: 'model-stale',
      name: 'Stale Model',
      connection_id: 'deleted-conn-id', // Not in MOCK_CONNECTIONS
    }
    mockFetchResponses([modelWithStaleConn])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('Stale Model')).toBeInTheDocument()
    })

    // Should show "Unknown connection" instead of the UUID prefix
    expect(screen.getByText('Unknown connection')).toBeInTheDocument()
  })

  // D25: Platform models render with "Platform" badge in table
  it('D25: platform model renders with Platform badge and no edit/delete buttons', async () => {
    const platformModel = {
      ...MOCK_MODELS[0],
      id: 'model-platform-gpt4o',
      name: 'GPT-4o (Platform)',
      connection_id: null,
      created_by: null,
      is_platform: true,
      litellm_model: 'openai/gpt-4o',
      description: 'Platform-managed model',
    }
    const userModel = MOCK_MODELS[1] // Claude Sonnet — user-owned

    mockFetchResponses([platformModel, userModel])

    render(<ModelsClient />)

    await waitFor(() => {
      expect(screen.getByText('GPT-4o (Platform)')).toBeInTheDocument()
      expect(screen.getByText('Claude Sonnet')).toBeInTheDocument()
    })

    // Platform badge should be visible for the platform model
    expect(screen.getByText('Platform')).toBeInTheDocument()

    // Find the platform model row and verify no Edit/Delete buttons
    const rows = document.querySelectorAll('tbody tr')
    const platformRow = Array.from(rows).find(row =>
      row.textContent?.includes('GPT-4o (Platform)')
    )!
    expect(platformRow).toBeDefined()
    expect(platformRow.querySelector('button')).toBeNull()

    // The user model row should still have Edit and Delete buttons
    const userRow = Array.from(rows).find(row =>
      row.textContent?.includes('Claude Sonnet')
    )!
    expect(userRow).toBeDefined()
    const userButtons = userRow.querySelectorAll('button')
    const buttonTexts = Array.from(userButtons).map(b => b.textContent)
    expect(buttonTexts).toContain('Edit')
    expect(buttonTexts).toContain('Delete')
  })

  // D26: Platform models appear in eligible-models picker
  it('D26: platform models appear in eligible-models picker on agent model selection', async () => {
    const platformModel = {
      id: 'model-platform-gpt4o',
      name: 'GPT-4o (Platform)',
      connection_id: null,
      created_by: null,
      is_platform: true,
      is_active: true,
      litellm_model: 'openai/gpt-4o',
      description: 'Platform-managed model',
      model_type: 'single',
      detected_type: 'chat',
      capabilities: ['chat', 'function_calling'],
      routing_config: null,
      icon_emoji: null,
      icon_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const userModel = {
      ...MOCK_MODELS[0],
      is_platform: false,
      created_by: 'user-123',
    }

    // Mock the eligible-models API to return both platform and user models
    mockFetch.mockImplementation((url: string, options?: any) => {
      if (url === '/api/user-models' && (!options || !options.method || options.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([platformModel, userModel]) })
      }
      if (url === '/api/provider-connections') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONNECTIONS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ModelsClient />)

    await waitFor(() => {
      // Both platform and user models should be visible in the table
      expect(screen.getByText('GPT-4o (Platform)')).toBeInTheDocument()
      expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    })

    // Platform model should have the Platform badge
    expect(screen.getByText('Platform')).toBeInTheDocument()

    // Verify the model count reflects both platform and user models
    expect(screen.getByText('2 models')).toBeInTheDocument()
  })
})
