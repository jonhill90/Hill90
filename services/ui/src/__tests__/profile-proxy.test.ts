import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSession: any = null

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: { status?: number }) => ({
      _type: 'NextResponse.json',
      _data: data,
      _status: init?.status ?? 200,
    })),
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks — catch-all proxy
const catchAll = await import('@/app/api/profile/[...path]/route')
// Import after mocks — base proxy
const base = await import('@/app/api/profile/route')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCatchAllRequest(
  method: string,
  headerOverrides: Record<string, string | null> = {},
  query: Record<string, string> = {}
) {
  const searchParams = new URLSearchParams(query)
  const headerMap: Record<string, string | null> = {
    'content-type': null,
    'if-none-match': null,
    'if-modified-since': null,
    ...headerOverrides,
  }
  return {
    method,
    headers: {
      get: vi.fn((name: string) => headerMap[name.toLowerCase()] ?? null),
    },
    nextUrl: { searchParams },
    arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
  }
}

function makeBaseRequest(method: string, headerOverrides: Record<string, string | null> = {}) {
  const headerMap: Record<string, string | null> = {
    'content-type': null,
    ...headerOverrides,
  }
  return {
    method,
    headers: {
      get: vi.fn((name: string) => headerMap[name.toLowerCase()] ?? null),
    },
    text: vi.fn(() => Promise.resolve('{}')),
  }
}

function makeParams(pathSegments: string[]) {
  return { params: Promise.resolve({ path: pathSegments }) }
}

// ---------------------------------------------------------------------------
// Catch-all proxy: conditional headers (ETag/304)
// ---------------------------------------------------------------------------

describe('profile catch-all proxy — conditional headers', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSession = { accessToken: 'test-jwt' }
  })

  it('forwards If-None-Match header to upstream', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ ok: true }),
    })

    const req = makeCatchAllRequest('GET', { 'if-none-match': '"abc123"' })
    await catchAll.GET(req as any, makeParams(['avatar']))

    const fetchHeaders = mockFetch.mock.calls[0][1].headers
    expect(fetchHeaders['If-None-Match']).toBe('"abc123"')
  })

  it('forwards If-Modified-Since header to upstream', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ ok: true }),
    })

    const req = makeCatchAllRequest('GET', { 'if-modified-since': 'Wed, 21 Oct 2025 07:28:00 GMT' })
    await catchAll.GET(req as any, makeParams(['avatar']))

    const fetchHeaders = mockFetch.mock.calls[0][1].headers
    expect(fetchHeaders['If-Modified-Since']).toBe('Wed, 21 Oct 2025 07:28:00 GMT')
  })

  it('does not set conditional headers when browser omits them', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ ok: true }),
    })

    const req = makeCatchAllRequest('GET')
    await catchAll.GET(req as any, makeParams(['avatar']))

    const fetchHeaders = mockFetch.mock.calls[0][1].headers
    expect(fetchHeaders['If-None-Match']).toBeUndefined()
    expect(fetchHeaders['If-Modified-Since']).toBeUndefined()
  })

  it('returns 304 as-is when upstream responds 304', async () => {
    mockFetch.mockResolvedValue({
      status: 304,
      headers: { get: () => null },
    })

    const req = makeCatchAllRequest('GET', { 'if-none-match': '"abc123"' })
    const res = await catchAll.GET(req as any, makeParams(['avatar']))

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(304)
  })
})

// ---------------------------------------------------------------------------
// Catch-all proxy: binary streaming (avatar image)
// ---------------------------------------------------------------------------

describe('profile catch-all proxy — binary streaming', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSession = { accessToken: 'test-jwt' }
  })

  it('streams image response with correct headers', async () => {
    const mockStream = new ReadableStream()
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/webp'
          if (name === 'cache-control') return 'private, no-cache'
          if (name === 'etag') return '"img-etag"'
          return null
        },
      },
      body: mockStream,
    })

    const req = makeCatchAllRequest('GET')
    const res = await catchAll.GET(req as any, makeParams(['avatar']))

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(res.headers.get('ETag')).toBe('"img-etag"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('handles image response without etag', async () => {
    const mockStream = new ReadableStream()
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/webp'
          if (name === 'cache-control') return null
          return null
        },
      },
      body: mockStream,
    })

    const req = makeCatchAllRequest('GET')
    const res = await catchAll.GET(req as any, makeParams(['avatar']))

    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('ETag')).toBeNull()
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })
})

// ---------------------------------------------------------------------------
// Catch-all proxy: auth
// ---------------------------------------------------------------------------

describe('profile catch-all proxy — auth', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns 401 without session', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = null

    const req = makeCatchAllRequest('GET')
    await catchAll.GET(req as any, makeParams(['avatar']))

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })

  it('returns 502 when upstream fetch fails', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'test-jwt' }
    mockFetch.mockRejectedValue(new Error('connection refused'))

    const req = makeCatchAllRequest('GET')
    await catchAll.GET(req as any, makeParams(['avatar']))

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'API request failed' },
      { status: 502 }
    )
  })
})

// ---------------------------------------------------------------------------
// Base profile proxy
// ---------------------------------------------------------------------------

describe('profile base proxy', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.clearAllMocks()
  })

  it('returns 401 without session', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = null

    const req = makeBaseRequest('GET')
    await base.GET(req as any)

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })

  it('proxies GET and returns JSON', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'test-jwt' }
    mockFetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ firstName: 'Jon', lastName: 'Hill' }),
    })

    const req = makeBaseRequest('GET')
    await base.GET(req as any)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/profile'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-jwt' }),
      })
    )
    expect(NextResponse.json).toHaveBeenCalledWith(
      { firstName: 'Jon', lastName: 'Hill' },
      { status: 200 }
    )
  })

  it('forwards body for PATCH requests', async () => {
    mockSession = { accessToken: 'test-jwt' }
    mockFetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ firstName: 'Updated' }),
    })

    const req = makeBaseRequest('PATCH', { 'content-type': 'application/json' })
    await base.PATCH(req as any)

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.method).toBe('PATCH')
    expect(fetchOpts.headers['Content-Type']).toBe('application/json')
  })

  it('returns 502 when upstream fails', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'test-jwt' }
    mockFetch.mockRejectedValue(new Error('timeout'))

    const req = makeBaseRequest('GET')
    await base.GET(req as any)

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'API request failed' },
      { status: 502 }
    )
  })

  it('returns upstream error status', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'test-jwt' }
    mockFetch.mockResolvedValue({
      status: 500,
      json: () => Promise.resolve({ error: 'Internal Server Error' }),
    })

    const req = makeBaseRequest('GET')
    await base.GET(req as any)

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  })
})
