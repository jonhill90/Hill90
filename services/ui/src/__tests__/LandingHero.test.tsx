import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockSignIn = vi.fn()

vi.mock('next-auth/react', () => ({
  signIn: (...args: any[]) => mockSignIn(...args),
}))

import LandingHero from '@/components/LandingHero'

describe('LandingHero', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('T1: shows landing hero when rendered', () => {
    render(<LandingHero />)

    expect(screen.getByText('Hill90')).toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
    expect(screen.getByText(/infrastructure automation/i)).toBeInTheDocument()
  })

  it('T2: landing hero has sign-in button that calls signIn', () => {
    render(<LandingHero />)

    const signInButton = screen.getByTestId('landing-sign-in')
    expect(signInButton).toBeInTheDocument()
    expect(signInButton).toHaveTextContent('Sign in')

    fireEvent.click(signInButton)
    expect(mockSignIn).toHaveBeenCalledWith('keycloak')
  })
})
