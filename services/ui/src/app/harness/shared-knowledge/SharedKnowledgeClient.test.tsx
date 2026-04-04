import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import SharedKnowledgeClient from './SharedKnowledgeClient'

let mockSession: { user: { sub: string; roles: string[] } } | null = {
  user: { sub: 'test-user', roles: ['user'] },
}

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? 'authenticated' : 'unauthenticated' }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/shared-knowledge',
  useRouter: () => ({ push: vi.fn() }),
}))

const mockCollections = [
  { id: 'col-1', name: 'Test Collection', description: 'A test', visibility: 'shared', created_by: 'test-user', created_at: '2026-01-01' },
]

const mockSearchResults = {
  query: 'test',
  results: [
    {
      chunk_id: 'c1', content: 'Test content', headline: 'Test <b>headline</b>',
      score: 0.95, quality_score: 1.0, quality_label: 'high',
      chunk_index: 0, source_title: 'Source A', source_url: null, collection_name: 'Col A',
    },
    {
      chunk_id: 'c2', content: 'Another result', headline: 'Another <b>result</b>',
      score: 0.2, quality_score: 0.2105, quality_label: 'medium',
      chunk_index: 1, source_title: 'Source B', source_url: null, collection_name: 'Col B',
    },
    {
      chunk_id: 'c3', content: 'Low result', headline: 'Low <b>result</b>',
      score: 0.02, quality_score: 0.0211, quality_label: 'low',
      chunk_index: 2, source_title: 'Source C', source_url: null, collection_name: 'Col C',
    },
  ],
  count: 3,
  search_type: 'fts',
  score_type: 'ts_rank',
  quality_summary: {
    avg_score: 0.4105,
    min_score: 0.0211,
    max_score: 1.0,
    distribution: { high: 1, medium: 1, low: 1 },
  },
}

const mockStats = {
  search: { total: 50, zero_result_count: 5, zero_result_rate: 0.1, avg_duration_ms: 12, by_requester_type: [] },
  ingest: { total_jobs: 10, completed: 8, failed: 1, running: 0, pending: 1, error_rate: 0.1, avg_processing_ms: 200 },
  sources: { by_status: { active: 5 }, by_type: { text: 3, web_page: 2 } },
  corpus: { total_collections: 3, total_sources: 5, total_chunks: 100, total_tokens: 50000 },
  usage: {
    top_collections: [
      { id: 'col-1', name: 'Popular Collection', retrieval_count: 25 },
      { id: 'col-2', name: 'Other Collection', retrieval_count: 10 },
    ],
    top_sources: [
      { id: 'src-1', title: 'Popular Source', collection_name: 'Docs Collection', retrieval_count: 15 },
    ],
  },
  since: null,
}

function setupFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/shared-knowledge/collections')) {
      return { ok: true, json: async () => overrides.collections ?? mockCollections }
    }
    if (typeof url === 'string' && url.includes('/api/shared-knowledge/search')) {
      return { ok: true, json: async () => overrides.search ?? mockSearchResults }
    }
    if (typeof url === 'string' && url.includes('/api/shared-knowledge/stats')) {
      return { ok: true, json: async () => overrides.stats ?? mockStats }
    }
    if (typeof url === 'string' && url.includes('/api/shared-knowledge/sources')) {
      return { ok: true, json: async () => overrides.sources ?? [] }
    }
    return { ok: false, json: async () => ({}) }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession = { user: { sub: 'test-user', roles: ['user'] } }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SharedKnowledgeClient quality badges', () => {
  it('renders quality badges on search results', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch

    render(<SharedKnowledgeClient />)

    // Wait for loading to finish
    await waitFor(() => expect(screen.queryByText('Library')).toBeInTheDocument())

    // Switch to search tab (use role to avoid matching the submit button)
    const tabs = screen.getAllByRole('button')
    const searchTab = tabs.find(b => b.textContent === 'Search' && b.className.includes('border-b'))
      ?? tabs.find(b => b.textContent === 'Search')!
    fireEvent.click(searchTab)

    // Type a query and search
    const input = screen.getByPlaceholderText('Search shared knowledge...')
    fireEvent.change(input, { target: { value: 'test' } })
    // Click the submit button (not the tab)
    const searchButtons = screen.getAllByText('Search')
    const submitBtn = searchButtons.find(b => b.tagName === 'BUTTON' && b.className.includes('bg-brand'))!
    fireEvent.click(submitBtn)

    // Wait for results
    await waitFor(() => expect(screen.getAllByTestId('quality-badge')).toHaveLength(3))

    const badges = screen.getAllByTestId('quality-badge')
    expect(badges[0]).toHaveTextContent('high')
    expect(badges[1]).toHaveTextContent('medium')
    expect(badges[2]).toHaveTextContent('low')
  })

  it('renders quality summary bar', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch

    render(<SharedKnowledgeClient />)
    await waitFor(() => expect(screen.queryByText('Library')).toBeInTheDocument())

    const tabs = screen.getAllByRole('button')
    const searchTab = tabs.find(b => b.textContent === 'Search' && b.className.includes('border-b'))
      ?? tabs.find(b => b.textContent === 'Search')!
    fireEvent.click(searchTab)
    const input = screen.getByPlaceholderText('Search shared knowledge...')
    fireEvent.change(input, { target: { value: 'test' } })
    const searchButtons = screen.getAllByText('Search')
    const submitBtn = searchButtons.find(b => b.tagName === 'BUTTON' && b.className.includes('bg-brand'))!
    fireEvent.click(submitBtn)

    await waitFor(() => expect(screen.getByTestId('quality-summary')).toBeInTheDocument())

    const summary = screen.getByTestId('quality-summary')
    expect(summary).toHaveTextContent('1 high')
    expect(summary).toHaveTextContent('1 medium')
    expect(summary).toHaveTextContent('1 low')
  })
})

describe('SharedKnowledgeClient usage rankings', () => {
  it('renders top collections table on Quality tab', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch

    render(<SharedKnowledgeClient />)
    await waitFor(() => expect(screen.queryByText('Library')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => expect(screen.getByTestId('top-collections')).toBeInTheDocument())

    expect(screen.getByText('Most Accessed Collections')).toBeInTheDocument()
    expect(screen.getByText('Popular Collection')).toBeInTheDocument()
    expect(screen.getByText('Other Collection')).toBeInTheDocument()
  })

  it('renders top sources table on Quality tab', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch

    render(<SharedKnowledgeClient />)
    await waitFor(() => expect(screen.queryByText('Library')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => expect(screen.getByTestId('top-sources')).toBeInTheDocument())

    expect(screen.getByText('Most Accessed Sources')).toBeInTheDocument()
    expect(screen.getByText('Popular Source')).toBeInTheDocument()
  })

  it('shows empty state when no usage data', async () => {
    const emptyUsageStats = {
      ...mockStats,
      usage: { top_collections: [], top_sources: [] },
    }
    global.fetch = setupFetch({ stats: emptyUsageStats }) as unknown as typeof fetch

    render(<SharedKnowledgeClient />)
    await waitFor(() => expect(screen.queryByText('Library')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => expect(screen.getByText('No collection usage data yet')).toBeInTheDocument())
    expect(screen.getByText('No source usage data yet')).toBeInTheDocument()
  })
})
