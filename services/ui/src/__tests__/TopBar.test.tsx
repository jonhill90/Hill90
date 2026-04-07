import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

describe('TopBar — Notification dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = {
      data: { user: { name: 'Jon', roles: ['admin', 'user'] } },
      status: 'authenticated',
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('shows notification bell when authenticated', () => {
    render(<TopBar />)
    expect(screen.getByTestId('notifications-bell')).toBeInTheDocument()
  })

  it('shows unread badge count', () => {
    render(<TopBar />)
    // Mock data has 3 unread notifications
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('opens dropdown on bell click', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('notifications-dropdown')).toBeInTheDocument()
    expect(screen.getByText('Notifications')).toBeInTheDocument()
  })

  it('shows notification items', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    const items = screen.getAllByTestId('notification-item')
    expect(items.length).toBe(5)
  })

  it('shows agent names on notifications', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getAllByText('ResearchBot').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('CodeAssistant').length).toBeGreaterThanOrEqual(1)
  })

  it('shows mark all read button when unread exist', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('mark-all-read')).toBeInTheDocument()
  })

  it('mark all read clears unread badge', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(screen.getByTestId('mark-all-read'))
    // Badge should be gone (0 unread)
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('closes dropdown on second bell click', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('notifications-dropdown')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.queryByTestId('notifications-dropdown')).not.toBeInTheDocument()
  })
})
