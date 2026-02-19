import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
const mockSignIn = vi.fn()
const mockSignOut = vi.fn()
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: (...args: any[]) => mockSignIn(...args),
  signOut: (...args: any[]) => mockSignOut(...args),
}))

import AuthButtons from '@/components/AuthButtons'

describe('AuthButtons', () => {
  it('renders sign-in avatar button when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AuthButtons />)

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('renders initials circle and "Sign out" when authenticated', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('AH')).toBeInTheDocument()
    expect(screen.getByTitle('Admin Hill90')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('renders single initial for single-word names', () => {
    mockSession = {
      data: { user: { name: 'Madonna' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getByTitle('Madonna')).toBeInTheDocument()
  })

  it('renders initials from the first two words for multi-word names', () => {
    mockSession = {
      data: { user: { name: 'John Paul Jones' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('JP')).toBeInTheDocument()
    expect(screen.getByTitle('John Paul Jones')).toBeInTheDocument()
  })

  it('renders pulsing placeholder during loading', () => {
    mockSession = { data: null, status: 'loading' }

    render(<AuthButtons />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading user information')).toBeInTheDocument()
  })
})
