import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SharedKnowledgeClient from '@/app/harness/shared-knowledge/SharedKnowledgeClient'

const MOCK_COLLECTIONS = [
  {
    id: 'col-1',
    name: 'Engineering Docs',
    description: 'Internal engineering documentation',
    visibility: 'shared',
    created_by: 'user-1',
    created_at: '2026-02-28T12:00:00Z',
  },
  {
    id: 'col-2',
    name: 'Personal Notes',
    description: '',
    visibility: 'private',
    created_by: 'user-1',
    created_at: '2026-02-27T12:00:00Z',
  },
]

const MOCK_SOURCES = [
  {
    id: 'src-1',
    collection_id: 'col-1',
    title: 'Setup Guide',
    source_type: 'text',
    source_url: null,
    status: 'active',
    error_message: null,
    content_hash: 'abc123',
    created_at: '2026-02-28T12:00:00Z',
  },
  {
    id: 'src-2',
    collection_id: 'col-1',
    title: 'Architecture Overview',
    source_type: 'web_page',
    source_url: 'https://example.com/arch',
    status: 'active',
    error_message: null,
    content_hash: 'def456',
    created_at: '2026-02-28T13:00:00Z',
  },
  {
    id: 'src-3',
    collection_id: 'col-1',
    title: 'Failed Import',
    source_type: 'web_page',
    source_url: 'https://example.com/broken',
    status: 'error',
    error_message: 'Connection timed out',
    content_hash: '',
    created_at: '2026-02-28T14:00:00Z',
  },
]

const MOCK_SEARCH_RESULTS = {
  query: 'setup guide',
  results: [
    {
      chunk_id: 'chunk-1',
      content: 'This is the setup guide content.',
      headline: 'This is the <b>setup</b> <b>guide</b> content.',
      score: 0.8765,
      chunk_index: 0,
      source_title: 'Setup Guide',
      source_url: null,
      collection_name: 'Engineering Docs',
    },
    {
      chunk_id: 'chunk-2',
      content: 'Architecture setup instructions.',
      headline: 'Architecture <b>setup</b> instructions.',
      score: 0.5432,
      chunk_index: 1,
      source_title: 'Architecture Overview',
      source_url: 'https://example.com/arch',
      collection_name: 'Engineering Docs',
    },
  ],
  count: 2,
  search_type: 'fts',
  score_type: 'ts_rank',
}

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/shared-knowledge/collections') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_COLLECTIONS) })
    }
    if (typeof url === 'string' && url.startsWith('/api/shared-knowledge/sources?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SOURCES) })
    }
    if (typeof url === 'string' && url.startsWith('/api/shared-knowledge/search?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SEARCH_RESULTS) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('SharedKnowledgeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders page title and tabs', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    expect(screen.getByText('Collections & Sources')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
  })

  it('renders collections list', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
      expect(screen.getByText('Personal Notes')).toBeInTheDocument()
    })

    // Visibility badges
    expect(screen.getByText('shared')).toBeInTheDocument()
    expect(screen.getByText('private')).toBeInTheDocument()
  })

  it('shows empty state when no collection selected', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('No collection selected')).toBeInTheDocument()
    })
  })

  it('fetches and displays sources when collection clicked', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('Setup Guide')).toBeInTheDocument()
      expect(screen.getByText('Architecture Overview')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/shared-knowledge/sources?collection_id=col-1')
    )
  })

  it('shows source type badges', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('text')).toBeInTheDocument()
      expect(screen.getAllByText('web_page').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows source status badges', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getAllByText('active').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('error')).toBeInTheDocument()
    })
  })

  it('shows error message for failed sources', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('Connection timed out')).toBeInTheDocument()
    })
  })

  it('shows source URL for web_page sources', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      const link = screen.getByText('https://example.com/arch')
      expect(link).toBeInTheDocument()
      expect(link.closest('a')).toHaveAttribute('href', 'https://example.com/arch')
    })
  })

  it('shows create collection form when New button clicked', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('New'))

    expect(screen.getByText('New Collection')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Collection name')).toBeInTheDocument()
  })

  it('submits create collection form', async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/shared-knowledge/collections' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'col-new', name: 'New Col' }) })
      }
      if (url === '/api/shared-knowledge/collections') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_COLLECTIONS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('New'))
    fireEvent.change(screen.getByPlaceholderText('Collection name'), { target: { value: 'New Col' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/shared-knowledge/collections',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  it('shows add source form with type selector', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('Add Source')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Source'))

    expect(screen.getByPlaceholderText('Source title')).toBeInTheDocument()
    // Type selector should have options
    const typeSelect = screen.getAllByRole('combobox').find(
      s => (s as HTMLSelectElement).value === 'text'
    )
    expect(typeSelect).toBeTruthy()
  })

  it('shows URL field when web_page type selected', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('Add Source')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Source'))

    // Change type to web_page
    const typeSelect = screen.getAllByRole('combobox').find(
      s => (s as HTMLSelectElement).value === 'text'
    )!
    fireEvent.change(typeSelect, { target: { value: 'web_page' } })

    expect(screen.getByPlaceholderText('https://example.com/article')).toBeInTheDocument()
  })

  it('shows textarea when text type selected', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Engineering Docs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Engineering Docs'))

    await waitFor(() => {
      expect(screen.getByText('Add Source')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add Source'))

    expect(screen.getByPlaceholderText('Paste text content here...')).toBeInTheDocument()
  })

  it('searches and displays results', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    // Switch to search tab
    fireEvent.click(screen.getByText('Search'))

    const searchInput = screen.getByPlaceholderText('Search shared knowledge...')
    fireEvent.change(searchInput, { target: { value: 'setup guide' } })

    // Trigger search via Enter key (avoids ambiguity with Search tab button)
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByText('Setup Guide')).toBeInTheDocument()
      expect(screen.getByText('Architecture Overview')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/shared-knowledge/search?')
    )
  })

  it('search results show source attribution', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Search'))

    const searchInput = screen.getByPlaceholderText('Search shared knowledge...')
    fireEvent.change(searchInput, { target: { value: 'setup' } })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getAllByText('in Engineering Docs').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('search results show source URL link for web pages', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Search'))

    const searchInput = screen.getByPlaceholderText('Search shared knowledge...')
    fireEvent.change(searchInput, { target: { value: 'setup' } })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await waitFor(() => {
      const sourceLinks = screen.getAllByText('Source')
      expect(sourceLinks.length).toBeGreaterThanOrEqual(1)
      expect(sourceLinks[0].closest('a')).toHaveAttribute('href', 'https://example.com/arch')
    })
  })

  it('shows empty search state', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Search'))

    expect(screen.getByText('Search your knowledge base')).toBeInTheDocument()
  })

  it('shows empty collections state', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/shared-knowledge/collections') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('No collections yet')).toBeInTheDocument()
    })
  })

  it('shows collection filter in search tab', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Search'))

    // Collection filter dropdown
    const selects = screen.getAllByRole('combobox')
    const collectionFilter = selects.find(
      s => Array.from((s as HTMLSelectElement).options).some(o => o.text === 'All collections')
    )
    expect(collectionFilter).toBeTruthy()
  })
})
