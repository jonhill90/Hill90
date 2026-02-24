import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import AdminDocsLink from '@/components/AdminDocsLink'

describe('AdminDocsLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows API Docs link when user is admin', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<AdminDocsLink />)

    const link = screen.getByRole('link', { name: /api docs/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/docs/api')
  })

  it('hides API Docs link when user is not admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<AdminDocsLink />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('hides API Docs link when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AdminDocsLink />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })
})
