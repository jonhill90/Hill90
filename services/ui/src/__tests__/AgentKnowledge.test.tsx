import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentKnowledge from '@/app/agents/[id]/AgentKnowledge'

const MOCK_COLLECTIONS = [
  { id: 'col-1', name: 'Platform Docs', description: 'Internal documentation', visibility: 'shared', created_at: '2026-01-01T00:00:00Z' },
  { id: 'col-2', name: 'Research Notes', description: null, visibility: 'private', created_at: '2026-02-01T00:00:00Z' },
]

const MOCK_RESULTS = {
  results: [
    {
      chunk_id: 'ch-1',
      content: 'Deployment uses Docker Compose on VPS.',
      headline: '<b>Deployment</b> uses Docker Compose on VPS.',
      rank: 0.8,
      source_title: 'deployment.md',
      collection_name: 'Platform Docs',
    },
  ],
}

describe('AgentKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockImplementation((...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : ''
      if (url.includes('/api/shared-knowledge/collections')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_COLLECTIONS) })
      }
      if (url.includes('/api/shared-knowledge/search')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_RESULTS) })
      }
      return Promise.resolve({ ok: false })
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders search input and collections heading', async () => {
    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    expect(screen.getByText('Search Knowledge')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-search-input')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Available Collections')).toBeInTheDocument()
    })
  })

  it('fetches and displays collections', async () => {
    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    await waitFor(() => {
      expect(screen.getByTestId('collections-list')).toBeInTheDocument()
      expect(screen.getByText('Platform Docs')).toBeInTheDocument()
      expect(screen.getByText('Research Notes')).toBeInTheDocument()
    })
  })

  it('shows visibility badges', async () => {
    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    await waitFor(() => {
      expect(screen.getByText('shared')).toBeInTheDocument()
      expect(screen.getByText('private')).toBeInTheDocument()
    })
  })

  it('shows empty state when no collections', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    )

    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    await waitFor(() => {
      expect(screen.getByTestId('no-collections')).toBeInTheDocument()
    })
  })

  it('searches and displays results', async () => {
    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    await waitFor(() => {
      expect(screen.getByText('Platform Docs')).toBeInTheDocument()
    })

    const input = screen.getByTestId('knowledge-search-input')
    fireEvent.change(input, { target: { value: 'deployment' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(screen.getByTestId('search-results')).toBeInTheDocument()
      expect(screen.getByText('deployment.md')).toBeInTheDocument()
    })
  })

  it('shows no results message on empty search', async () => {
    mockFetch.mockImplementation((...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : ''
      if (url.includes('/api/shared-knowledge/collections')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_COLLECTIONS) })
      }
      if (url.includes('/api/shared-knowledge/search')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) })
      }
      return Promise.resolve({ ok: false })
    })

    render(<AgentKnowledge agentName="TestBot" agentId="test-bot" />)

    await waitFor(() => {
      expect(screen.getByText('Platform Docs')).toBeInTheDocument()
    })

    const input = screen.getByTestId('knowledge-search-input')
    fireEvent.change(input, { target: { value: 'nonexistent' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(screen.getByText('No results found.')).toBeInTheDocument()
    })
  })

  it('includes agent name in description', async () => {
    render(<AgentKnowledge agentName="ResearchBot" agentId="research-bot" />)

    expect(screen.getByText(/ResearchBot/)).toBeInTheDocument()
  })
})
