import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: vi.fn(),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

// Mock localStorage for Sidebar (rendered inside TopBar's MobileDrawer)
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

import TopBar from '@/components/TopBar'

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = { data: null, status: 'unauthenticated' }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Hill90 logo', () => {
    render(<TopBar />)

    expect(screen.getByRole('img', { name: /hill90 logo/i })).toBeInTheDocument()
  })

  it('renders AuthButtons', () => {
    render(<TopBar />)

    // When unauthenticated, AuthButtons renders a Sign in button
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('renders navExtra breadcrumb', () => {
    render(<TopBar navExtra={<span data-testid="breadcrumb">Profile / Edit</span>} />)

    expect(screen.getByTestId('breadcrumb')).toBeInTheDocument()
    expect(screen.getByText('Profile / Edit')).toBeInTheDocument()
  })

  it('renders hamburger menu button when authenticated', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<TopBar />)

    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument()
  })

  it('T7: hides hamburger menu when logged out', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<TopBar />)

    expect(screen.queryByRole('button', { name: /open menu/i })).not.toBeInTheDocument()
  })
})
