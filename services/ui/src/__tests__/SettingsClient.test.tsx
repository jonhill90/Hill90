import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['user'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
}))

import SettingsClient from '@/app/settings/SettingsClient'

const MOCK_PREFS = { in_app_notifications: true, email_notifications: false, theme: 'dark' }

describe('SettingsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: any) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...MOCK_PREFS, ...JSON.parse(opts.body) }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PREFS) })
    }))
  })

  afterEach(() => {
    cleanup()
  })

  it('renders settings page title', async () => {
    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument()
    })
  })

  it('shows theme section', async () => {
    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('Dark')).toBeInTheDocument()
    })
  })

  it('shows notifications section with checkboxes', async () => {
    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('Notifications')).toBeInTheDocument()
    })
    expect(screen.getByText('In-app notifications')).toBeInTheDocument()
    expect(screen.getByText('Email notifications')).toBeInTheDocument()
  })

  it('in-app notifications checkbox is checked by default', async () => {
    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('In-app notifications')).toBeInTheDocument()
    })
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked()
    expect(checkboxes[1]).not.toBeChecked()
  })

  it('toggling checkbox calls save API', async () => {
    const fetchMock = vi.fn((url: string, opts?: any) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...MOCK_PREFS, email_notifications: true }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PREFS) })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('Email notifications')).toBeInTheDocument()
    })
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1])
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/preferences', expect.objectContaining({ method: 'PUT' }))
    })
  })

  it('shows API Keys coming soon section', async () => {
    render(<SettingsClient />)
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument()
      expect(screen.getByText('Coming soon')).toBeInTheDocument()
    })
  })
})
