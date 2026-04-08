import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import CommandPalette from '@/components/CommandPalette'

function openPalette() {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('is hidden by default', () => {
    render(<CommandPalette />)
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument()
  })

  it('opens on Ctrl+K', () => {
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('command-palette')).toBeInTheDocument()
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
  })

  it('shows all nav items when no query', () => {
    render(<CommandPalette />)
    openPalette()
    const items = screen.getAllByTestId('command-palette-item')
    expect(items.length).toBeGreaterThan(5)
  })

  it('filters results by query', () => {
    render(<CommandPalette />)
    openPalette()

    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'chat' } })
    const items = screen.getAllByTestId('command-palette-item')
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items.some(el => el.textContent?.includes('Chat'))).toBe(true)
  })

  it('shows no results for unmatched query', () => {
    render(<CommandPalette />)
    openPalette()

    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'xyznonexistent' } })
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('closes on Escape', () => {
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('command-palette')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Escape' })
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument()
  })

  it('closes on overlay click', () => {
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('command-palette')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('command-palette-overlay'))
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument()
  })

  it('navigates on Enter', () => {
    render(<CommandPalette />)
    openPalette()

    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dashboard' } })
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Enter' })

    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('navigates on item click', () => {
    render(<CommandPalette />)
    openPalette()

    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'agents' } })
    const items = screen.getAllByTestId('command-palette-item')
    fireEvent.click(items[0])

    expect(mockPush).toHaveBeenCalled()
  })
})
