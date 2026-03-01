import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import UsageClient from '@/app/harness/usage/UsageClient'

const MOCK_SUMMARY = {
  total_requests: 142,
  successful_requests: 140,
  total_input_tokens: 50000,
  total_output_tokens: 25000,
  total_tokens: 75000,
  total_cost_usd: 1.2345,
}

const MOCK_AGENTS = [
  { id: 'agent-uuid-1', name: 'ResearchBot', agent_id: 'research-bot' },
  { id: 'agent-uuid-2', name: 'WriterBot', agent_id: 'writer-bot' },
]

const MOCK_GROUPED_BY_AGENT = {
  data: [
    { agent_id: 'agent-uuid-1', total_requests: 100, total_tokens: 50000, total_cost_usd: 0.8 },
    { agent_id: 'agent-uuid-2', total_requests: 42, total_tokens: 25000, total_cost_usd: 0.4345 },
  ],
  group_by: 'agent',
}

const MOCK_GROUPED_BY_MODEL = {
  data: [
    { model_name: 'gpt-4o-mini', total_requests: 120, total_tokens: 60000, total_cost_usd: 0.9 },
    { model_name: 'claude-sonnet', total_requests: 22, total_tokens: 15000, total_cost_usd: 0.3345 },
  ],
  group_by: 'model',
}

function mockFetchResponses(grouped = MOCK_GROUPED_BY_AGENT) {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/usage') && url.includes('group_by')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(grouped) })
    }
    if (typeof url === 'string' && url.startsWith('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SUMMARY) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('UsageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchResponses()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders summary cards with formatted values', async () => {
    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getByText('142')).toBeInTheDocument()
      expect(screen.getByText('75,000')).toBeInTheDocument()
      expect(screen.getByText('$1.2345')).toBeInTheDocument()
    })

    expect(screen.getByText('Total Requests')).toBeInTheDocument()
    expect(screen.getByText('Total Tokens')).toBeInTheDocument()
    expect(screen.getByText('Estimated Cost')).toBeInTheDocument()
  })

  it('renders grouped data table with agent names', async () => {
    render(<UsageClient />)

    // Agent names appear in both table rows and the filter dropdown
    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('WriterBot').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows empty state when no data', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/usage') && url.includes('group_by')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) })
      }
      if (typeof url === 'string' && url.startsWith('/api/usage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SUMMARY) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getByText('No usage data yet')).toBeInTheDocument()
    })
  })

  it('renders group-by toggle buttons', async () => {
    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getByText('Group by:')).toBeInTheDocument()
    })

    // Group-by buttons (Agent, Model, Day) exist as toggle buttons
    const buttons = screen.getAllByRole('button')
    const buttonTexts = buttons.map(b => b.textContent)
    expect(buttonTexts).toContain('Agent')
    expect(buttonTexts).toContain('Model')
    expect(buttonTexts).toContain('Day')
  })

  it('changes group-by and re-fetches', async () => {
    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThanOrEqual(1)
    })

    mockFetchResponses(MOCK_GROUPED_BY_MODEL)

    // Click the "Model" group-by button (not the filter label)
    const buttons = screen.getAllByRole('button')
    const modelButton = buttons.find(b => b.textContent === 'Model')!
    fireEvent.click(modelButton)

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    })
  })

  it('renders filter bar with date inputs and agent dropdown', async () => {
    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThanOrEqual(1)
    })

    // Date inputs
    const dateInputs = screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/)
    expect(dateInputs.length).toBe(2)

    // Agent dropdown
    expect(screen.getByText('All agents')).toBeInTheDocument()

    // Model filter input
    expect(screen.getByPlaceholderText('Filter by model')).toBeInTheDocument()
  })

  it('shows table header matching group-by selection', async () => {
    render(<UsageClient />)

    await waitFor(() => {
      expect(screen.getAllByText('ResearchBot').length).toBeGreaterThanOrEqual(1)
    })

    // Default group is 'agent', first column header should say "Agent"
    const headers = screen.getAllByRole('columnheader')
    expect(headers[0]).toHaveTextContent('Agent')
    expect(headers[1]).toHaveTextContent('Requests')
    expect(headers[2]).toHaveTextContent('Tokens')
    expect(headers[3]).toHaveTextContent('Cost')
  })
})
