import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['user'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/storage',
}))

import StorageClient from '@/app/harness/storage/StorageClient'

const MOCK_BUCKETS = [
  { name: 'agent-files', created_at: '2026-03-01T00:00:00Z' },
  { name: 'uploads', created_at: '2026-03-15T00:00:00Z' },
]

const MOCK_OBJECTS: { objects: any[]; prefixes: string[]; is_truncated: boolean; next_continuation_token: null; key_count: number } = {
  objects: [
    { key: 'readme.md', size: 1024, last_modified: '2026-04-01T00:00:00Z', etag: '"abc"' },
    { key: 'data.json', size: 2048000, last_modified: '2026-04-10T00:00:00Z', etag: '"def"' },
  ],
  prefixes: ['logs/', 'backups/'],
  is_truncated: false,
  next_continuation_token: null,
  key_count: 4,
}

describe('StorageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders storage page title', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BUCKETS) })))
    render(<StorageClient />)
    await waitFor(() => {
      expect(screen.getByText('Storage')).toBeInTheDocument()
    })
  })

  it('shows bucket list after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BUCKETS) })))
    render(<StorageClient />)
    await waitFor(() => {
      expect(screen.getByText('agent-files')).toBeInTheDocument()
    })
    expect(screen.getByText('uploads')).toBeInTheDocument()
  })

  it('shows empty state when no buckets', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<StorageClient />)
    await waitFor(() => {
      expect(screen.getByText(/no buckets/i)).toBeInTheDocument()
    })
  })

  it('navigates into bucket on click', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/objects')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_OBJECTS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BUCKETS) })
    }))
    render(<StorageClient />)
    await waitFor(() => {
      expect(screen.getByText('agent-files')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('agent-files'))
    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument()
    })
  })

  it('shows file sizes', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/objects')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_OBJECTS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BUCKETS) })
    }))
    render(<StorageClient />)
    await waitFor(() => { expect(screen.getByText('agent-files')).toBeInTheDocument() })
    fireEvent.click(screen.getByText('agent-files'))
    await waitFor(() => {
      expect(screen.getByText('1.0 KB')).toBeInTheDocument()
    })
  })

  it('shows folder prefixes', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/objects')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_OBJECTS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BUCKETS) })
    }))
    render(<StorageClient />)
    await waitFor(() => { expect(screen.getByText('agent-files')).toBeInTheDocument() })
    fireEvent.click(screen.getByText('agent-files'))
    await waitFor(() => {
      expect(screen.getByText('logs/')).toBeInTheDocument()
      expect(screen.getByText('backups/')).toBeInTheDocument()
    })
  })

  it('handles fetch error gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'fail' }) })))
    render(<StorageClient />)
    await waitFor(() => {
      // Should show error or empty state, not crash
      expect(screen.getByText('Storage')).toBeInTheDocument()
    })
  })
})
