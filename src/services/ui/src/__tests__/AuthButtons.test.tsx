import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
const mockSignIn = vi.fn()
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: (...args: any[]) => mockSignIn(...args),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import AuthButtons from '@/components/AuthButtons'

describe('AuthButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders sign-in avatar button when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AuthButtons />)

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('renders pulsing placeholder during loading', () => {
    mockSession = { data: null, status: 'loading' }

    render(<AuthButtons />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading user information')).toBeInTheDocument()
  })

  it('renders avatar button with initials when authenticated', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('AH')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument()
  })

  it('avatar button has aria-haspopup="menu" and aria-expanded toggles', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    const button = screen.getByRole('button', { name: 'User menu' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('clicking avatar opens dropdown with Profile, Settings, Sign out', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Profile')
    expect(items[1]).toHaveTextContent('Settings')
    expect(items[2]).toHaveTextContent('Sign out')
  })

  it('clicking avatar again closes dropdown', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    const button = screen.getByRole('button', { name: 'User menu' })
    fireEvent.click(button)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Escape key closes dropdown', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Sign out item links to /api/auth/federated-logout', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const signOutItem = screen.getByRole('menuitem', { name: 'Sign out' })
    expect(signOutItem).toHaveAttribute('href', '/api/auth/federated-logout')
  })

  it('menu items have role="menuitem"', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
  })

  it('Profile links to /profile', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
  })

  it('Settings links to /settings', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  it('renders single initial for single-word names', () => {
    mockSession = {
      data: { user: { name: 'Madonna' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('M')).toBeInTheDocument()
  })

  it('renders initials from the first two words for multi-word names', () => {
    mockSession = {
      data: { user: { name: 'John Paul Jones' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('JP')).toBeInTheDocument()
  })
})
