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

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
    mockPathname = '/'
    mockSession = { data: null, status: 'unauthenticated' }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders core nav links for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })

  it('renders API Docs link for admin users', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
  })

  it('hides API Docs for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('highlights active route', () => {
    mockPathname = '/dashboard'
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i })
    expect(dashboardLink.getAttribute('aria-current')).toBe('page')
  })

  it('collapse persists to localStorage', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const collapseButton = screen.getByRole('button', { name: /collapse/i })
    fireEvent.click(collapseButton)

    expect(localStorageMock.setItem).toHaveBeenCalledWith('sidebar-collapsed', 'true')
  })

  it('renders Harness nav group', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const harnessButton = screen.getByRole('button', { name: /harness/i })
    expect(harnessButton).toBeInTheDocument()

    fireEvent.click(harnessButton)

    expect(screen.getByRole('link', { name: /connections/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /models/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /policies/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /usage/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /knowledge/i })).toBeInTheDocument()
  })

  it('highlights active harness route', () => {
    mockPathname = '/harness/connections'
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    // Harness group should auto-expand when a child is active
    const connectionsLink = screen.getByRole('link', { name: /connections/i })
    expect(connectionsLink.getAttribute('aria-current')).toBe('page')
  })

  it('hides labels when collapsed', () => {
    localStorageMock.getItem.mockReturnValue('true')
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    // Labels should be visually hidden (sr-only) when collapsed
    const homeLink = screen.getByRole('link', { name: /home/i })
    const label = homeLink.querySelector('[data-sidebar-label]')
    expect(label).toHaveClass('sr-only')
  })
})
