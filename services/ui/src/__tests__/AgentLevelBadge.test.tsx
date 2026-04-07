import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentLevelBadge from '@/components/AgentLevelBadge'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('AgentLevelBadge', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => cleanup())

  it('renders level badge when stats load', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ total_inferences: 500, chat_messages: 20 }),
    })

    render(<AgentLevelBadge agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('level-badge')).toBeInTheDocument()
    })

    // 500 + 20*0.5 = 510 XP -> Level 5 Journeyman
    expect(screen.getByTestId('level-badge')).toHaveTextContent('Lv.5 Journeyman')
  })

  it('renders nothing when stats fail', async () => {
    mockFetch.mockResolvedValue({ ok: false })

    const { container } = render(<AgentLevelBadge agentId="uuid-1" />)

    // Wait a tick for the effect to run
    await new Promise((r) => setTimeout(r, 50))

    expect(container.innerHTML).toBe('')
  })

  it('renders level 1 for zero stats', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ total_inferences: 0, chat_messages: 0 }),
    })

    render(<AgentLevelBadge agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('level-badge')).toBeInTheDocument()
    })

    expect(screen.getByTestId('level-badge')).toHaveTextContent('Lv.1 Novice')
  })
})
