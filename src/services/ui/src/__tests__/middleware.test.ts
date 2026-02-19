import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'

// Mock next/server
vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn((url: URL) => ({ type: 'redirect', url: url.toString() })),
  },
}))

// Mock @/auth to expose a controllable auth wrapper
let mockSession: any = null

vi.mock('@/auth', () => ({
  auth: (handler: Function) => {
    // Return a middleware function that invokes the handler with a mock request
    return (req: any) => {
      req.auth = mockSession
      return handler(req)
    }
  },
}))

// Import the middleware after mocks are set up
const { default: middleware } = await import('@/middleware')

function makeRequest(pathname: string) {
  return {
    url: `https://hill90.com${pathname}`,
    auth: null as any,
  }
}

describe('middleware', () => {
  it('redirects to /api/auth/signin when req.auth is null', () => {
    mockSession = null
    const req = makeRequest('/dashboard')

    const result = middleware(req as any)

    expect(NextResponse.redirect).toHaveBeenCalledWith(
      new URL('/api/auth/signin', 'https://hill90.com/dashboard')
    )
    expect(result).toBeDefined()
  })

  it('passes through when req.auth is present', () => {
    mockSession = { user: { name: 'Test' } }
    const req = makeRequest('/dashboard')

    const result = middleware(req as any)

    // When auth is present, handler returns undefined (no redirect)
    expect(result).toBeUndefined()
  })
})
