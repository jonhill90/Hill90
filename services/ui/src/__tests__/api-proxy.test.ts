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

const { proxyToApi } = await import('@/utils/api-proxy')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method = 'GET', query: Record<string, string> = {}, body?: string) {
  const searchParams = new URLSearchParams(query)
  return {
    method,
    headers: {
      get: vi.fn((name: string) => name === 'content-type' && body ? 'application/json' : null),
    },
    nextUrl: { searchParams },
    text: vi.fn(() => Promise.resolve(body || '')),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proxyToApi', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockSession = { accessToken: 'test-jwt' }
  })

  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = null

    await proxyToApi(makeRequest() as any, '/agents')

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })

  it('forwards GET request with auth header', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve([{ id: '1' }]),
    })

    await proxyToApi(makeRequest() as any, '/provider-connections')

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/provider-connections')
    expect(opts.headers.Authorization).toBe('Bearer test-jwt')
    expect(opts.method).toBe('GET')
  })

  it('forwards query params', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({}),
    })

    await proxyToApi(makeRequest('GET', { agent_id: 'abc' }) as any, '/usage')

    const url = mockFetch.mock.calls[0][0]
    expect(url).toContain('agent_id=abc')
  })

  it('forwards POST body', async () => {
    mockFetch.mockResolvedValue({
      status: 201,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ id: 'new-id' }),
    })

    const body = JSON.stringify({ name: 'test' })
    await proxyToApi(makeRequest('POST', {}, body) as any, '/provider-connections')

    const opts = mockFetch.mock.calls[0][1]
    expect(opts.body).toBe(body)
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  it('passes through SSE response without JSON parsing', async () => {
    const mockStream = new ReadableStream()
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => name === 'content-type' ? 'text/event-stream' : null,
      },
      body: mockStream,
    })

    const res = await proxyToApi(
      makeRequest('GET', { follow: 'true' }) as any,
      '/agents/123/logs'
    )

    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
  })

  it('returns 502 on fetch error', async () => {
    const { NextResponse } = await import('next/server')
    mockFetch.mockRejectedValue(new Error('Connection refused'))

    await proxyToApi(makeRequest() as any, '/agents')

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'API request failed' },
      { status: 502 }
    )
  })

  it('uses custom label in error logging', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFetch.mockRejectedValue(new Error('timeout'))

    await proxyToApi(makeRequest() as any, '/agents', { label: 'test-label' })

    expect(consoleSpy).toHaveBeenCalledWith('[test-label] Error:', expect.any(Error))
    consoleSpy.mockRestore()
  })
})
