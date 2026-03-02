import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SharedKnowledgeClient from '../app/harness/shared-knowledge/SharedKnowledgeClient'

const mockStats = {
  search: {
    total: 142,
    zero_result_count: 23,
    zero_result_rate: 0.162,
    avg_duration_ms: 45,
    by_requester_type: [
      { requester_type: 'user', total: 98, zero_result_count: 12, zero_result_rate: 0.122 },
      { requester_type: 'agent', total: 44, zero_result_count: 11, zero_result_rate: 0.25 },
    ],
  },
  ingest: {
    total_jobs: 50,
    completed: 45,
    failed: 3,
    running: 1,
    pending: 1,
    error_rate: 0.06,
    avg_processing_ms: 320,
  },
  sources: {
    by_status: { active: 40, error: 3, pending: 2 },
    by_type: { text: 20, markdown: 15, web_page: 10 },
  },
  corpus: {
    total_collections: 5,
    total_sources: 45,
    total_chunks: 312,
    total_tokens: 156000,
  },
  since: null,
}

function mockFetchWithStats() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/shared-knowledge/collections') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }
    if (typeof url === 'string' && url.startsWith('/api/shared-knowledge/stats')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(mockStats) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

function mockFetchCollectionsOnly() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/shared-knowledge/collections') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('SharedKnowledgeQuality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchWithStats()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Quality tab button', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    expect(screen.getByText('Quality')).toBeInTheDocument()
  })

  it('fetches stats on Quality tab click', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/shared-knowledge/stats')
    })
  })

  it('displays summary cards with values', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText('Total Searches')).toBeInTheDocument()
      expect(screen.getByText('Zero-Result %')).toBeInTheDocument()
      expect(screen.getByText('Ingest Err %')).toBeInTheDocument()
      expect(screen.getByText('Total Chunks')).toBeInTheDocument()
    })

    expect(screen.getByText('142')).toBeInTheDocument()
    expect(screen.getByText('312')).toBeInTheDocument()
  })

  it('formats zero_result_rate as %', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText('16.2%')).toBeInTheDocument()
    })
  })

  it('displays per-requester-type zero-result rates', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText(/98.*user.*12\.2% zero/)).toBeInTheDocument()
      expect(screen.getByText(/44.*agent.*25\.0% zero/)).toBeInTheDocument()
    })
  })

  it('displays ingest status badges', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText(/45.*completed/)).toBeInTheDocument()
      expect(screen.getByText(/3.*failed/)).toBeInTheDocument()
      expect(screen.getByText(/1.*running/)).toBeInTheDocument()
      expect(screen.getByText(/1.*pending/)).toBeInTheDocument()
    })
  })

  it('displays source breakdown', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText('By status')).toBeInTheDocument()
      expect(screen.getByText('By type')).toBeInTheDocument()
      expect(screen.getByText(/40.*active/)).toBeInTheDocument()
      expect(screen.getByText(/20.*text/)).toBeInTheDocument()
      expect(screen.getByText(/15.*markdown/)).toBeInTheDocument()
      expect(screen.getByText(/10.*web_page/)).toBeInTheDocument()
    })
  })

  it('time range changes since param', async () => {
    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText('Total Searches')).toBeInTheDocument()
    })

    mockFetch.mockClear()
    mockFetchWithStats()

    fireEvent.click(screen.getByText('7d'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/shared-knowledge/stats?since=')
      )
    })
  })

  it('handles empty stats', async () => {
    const emptyStats = {
      search: {
        total: 0,
        zero_result_count: 0,
        zero_result_rate: 0,
        avg_duration_ms: null,
        by_requester_type: [],
      },
      ingest: {
        total_jobs: 0,
        completed: 0,
        failed: 0,
        running: 0,
        pending: 0,
        error_rate: 0,
        avg_processing_ms: null,
      },
      sources: {
        by_status: {},
        by_type: {},
      },
      corpus: {
        total_collections: 0,
        total_sources: 0,
        total_chunks: 0,
        total_tokens: 0,
      },
      since: null,
    }

    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/shared-knowledge/collections') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (typeof url === 'string' && url.startsWith('/api/shared-knowledge/stats')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyStats) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<SharedKnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Shared Knowledge')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Quality'))

    await waitFor(() => {
      expect(screen.getByText('Total Searches')).toBeInTheDocument()
      // Multiple cards show "0" — use getAllByText
      expect(screen.getAllByText('0').length).toBeGreaterThan(0)
      expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0)
    })
  })
})
