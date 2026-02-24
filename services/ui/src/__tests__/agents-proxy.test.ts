import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSession: any = null

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

// Mock NextResponse.json
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: { status?: number }) => ({
      _type: 'NextResponse.json',
      _data: data,
      _status: init?.status ?? 200,
    })),
  },
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
const { GET } = await import('@/app/api/agents/[...path]/route')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(pathSegments: string[], query: Record<string, string> = {}) {
  const searchParams = new URLSearchParams(query)
  return {
    method: 'GET',
    headers: {
      get: vi.fn(() => null),
    },
    nextUrl: {
      searchParams,
    },
  }
}

function makeParams(pathSegments: string[]) {
  return { params: Promise.resolve({ path: pathSegments }) }
}

// ---------------------------------------------------------------------------
// SSE proxy pass-through for text/event-stream
// ---------------------------------------------------------------------------

describe('SSE proxy pass-through', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSession = { accessToken: 'test-jwt-token' }
  })

  it('returns raw Response with text/event-stream headers when upstream is SSE', async () => {
    const mockStream = new ReadableStream()
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => name === 'content-type' ? 'text/event-stream' : null,
      },
      body: mockStream,
    })

    const req = makeRequest(['some-id', 'logs'], { follow: 'true', tail: '100' })
    const res = await GET(req as any, makeParams(['some-id', 'logs']))

    // Must be a raw Response, NOT NextResponse.json
    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('does not set AbortSignal timeout for follow=true requests', async () => {
    const mockStream = new ReadableStream()
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => name === 'content-type' ? 'text/event-stream' : null,
      },
      body: mockStream,
    })

    const req = makeRequest(['some-id', 'logs'], { follow: 'true' })
    await GET(req as any, makeParams(['some-id', 'logs']))

    // Verify fetch was called without a signal
    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.signal).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Non-SSE JSON proxy behavior unchanged
// ---------------------------------------------------------------------------

describe('JSON proxy pass-through', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSession = { accessToken: 'test-jwt-token' }
  })

  it('parses JSON and returns NextResponse.json for non-SSE responses', async () => {
    const { NextResponse } = await import('next/server')
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => name === 'content-type' ? 'application/json' : null,
      },
      json: () => Promise.resolve({ id: '123', name: 'test-agent' }),
    })

    const req = makeRequest(['some-id'])
    const res = await GET(req as any, makeParams(['some-id']))

    expect(NextResponse.json).toHaveBeenCalledWith(
      { id: '123', name: 'test-agent' },
      { status: 200 }
    )
  })

  it('sets AbortSignal timeout for non-SSE requests', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      json: () => Promise.resolve({}),
    })

    const req = makeRequest(['some-id'])
    await GET(req as any, makeParams(['some-id']))

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.signal).toBeDefined()
  })

  it('returns 401 when session has no accessToken', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = null

    const req = makeRequest(['some-id'])
    await GET(req as any, makeParams(['some-id']))

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })
})
