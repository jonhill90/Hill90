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
let mockPathname = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
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
import MobileDrawer from '@/components/MobileDrawer'

describe('Admin nav group in Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
    mockPathname = '/'
    mockSession = { data: null, status: 'unauthenticated' }
  })

  afterEach(() => {
    cleanup()
  })

  it('hides Admin group for non-admin users', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.queryByRole('button', { name: /^admin$/i })).not.toBeInTheDocument()
  })

  it('shows Admin group for admin users', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /^admin$/i })).toBeInTheDocument()
  })

  it('shows Services link when Admin group is expanded', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /^admin$/i }))

    const servicesLink = screen.getByRole('link', { name: /services/i })
    expect(servicesLink).toBeInTheDocument()
    expect(servicesLink).toHaveAttribute('href', '/admin/services')
  })

  it('preserves Build/Connect/Observe groups for non-admin users', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /build/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /observe/i })).toBeInTheDocument()
  })
})

describe('Admin nav group in MobileDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPathname = '/'
    mockSession = { data: null, status: 'unauthenticated' }
    document.body.style.overflow = ''
  })

  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
  })

  it('hides Admin group for non-admin users', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /^admin$/i })).not.toBeInTheDocument()
  })

  it('shows Admin group for admin users', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: /^admin$/i })).toBeInTheDocument()
  })
})
