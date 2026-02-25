import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

import Sidebar from '@/components/Sidebar'

describe('Admin docs nav filtering (Sidebar)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows API Docs link when user is admin', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    const link = screen.getByRole('link', { name: /api docs/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/docs/api')
  })

  it('hides API Docs link when user is not admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('hides API Docs link when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<Sidebar />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })
})
