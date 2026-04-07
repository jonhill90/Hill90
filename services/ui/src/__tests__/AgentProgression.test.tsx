import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentProgression from '@/app/agents/[id]/AgentProgression'

const MOCK_STATS = {
  total_inferences: 1234,
  total_tokens: 567890,
  estimated_cost: 12.34,
  distinct_models: 3,
  knowledge_entries: 42,
  chat_messages: 89,
  total_uptime_seconds: 172800, // 2 days
  skills_assigned: 3,
  first_started: '2026-01-01T00:00:00Z',
}

const MOCK_ARTIFACTS = {
  artifacts: [
    { id: 'first_light', name: 'First Light', icon: '⚡', description: 'Completed first model inference', earned: true },
    { id: 'thousand_calls', name: 'Thousand Calls', icon: '🔥', description: '1,000 inferences completed', earned: true },
    { id: 'ten_thousand', name: 'Ten Thousand', icon: '💫', description: '10,000 inferences completed', earned: false },
    { id: 'polyglot', name: 'Polyglot', icon: '🌐', description: 'Used 2+ different models', earned: true },
  ],
  earned_count: 3,
}

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('AgentProgression', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/stats')) {
        return { ok: true, json: async () => MOCK_STATS }
      }
      if (typeof url === 'string' && url.includes('/artifacts')) {
        return { ok: true, json: async () => MOCK_ARTIFACTS }
      }
      return { ok: false, json: async () => ({}) }
    })
  })

  afterEach(() => cleanup())

  it('renders level section with XP bar', async () => {
    render(<AgentProgression agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('level-section')).toBeInTheDocument()
    })

    // 1234 inferences + 89*0.5 = 1278 XP -> Level 5 (Journeyman, threshold 400)
    // But 1278 >= 800 -> Level 6 (Journeyman, threshold 800)
    // 1278 < 1500 -> Level 6
    expect(screen.getByText(/Level 6/)).toBeInTheDocument()
    expect(screen.getByText('Journeyman')).toBeInTheDocument()
    expect(screen.getByTestId('xp-bar')).toBeInTheDocument()
    expect(screen.getByTestId('xp-fill')).toBeInTheDocument()
  })

  it('renders stats grid with formatted values', async () => {
    render(<AgentProgression agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('stats-grid')).toBeInTheDocument()
    })

    expect(screen.getByText('1.2K')).toBeInTheDocument() // inferences
    expect(screen.getByText('567.9K')).toBeInTheDocument() // tokens
    expect(screen.getByText('$12.34')).toBeInTheDocument() // cost
    expect(screen.getByText('42')).toBeInTheDocument() // knowledge
    expect(screen.getByText('89')).toBeInTheDocument() // messages
    expect(screen.getByText('2d 0h')).toBeInTheDocument() // uptime
  })

  it('renders earned and locked artifacts', async () => {
    render(<AgentProgression agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('artifacts-grid')).toBeInTheDocument()
    })

    const earned = screen.getAllByTestId('artifact-earned')
    const locked = screen.getAllByTestId('artifact-locked')
    expect(earned).toHaveLength(3)
    expect(locked).toHaveLength(1)
  })

  it('shows earned count', async () => {
    render(<AgentProgression agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('earned-count')).toBeInTheDocument()
    })

    expect(screen.getByTestId('earned-count')).toHaveTextContent('3 / 4 earned')
  })

  it('shows loading state', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}))

    render(<AgentProgression agentId="uuid-1" />)

    expect(screen.getByTestId('progression-loading')).toBeInTheDocument()
  })

  it('shows XP to next level text', async () => {
    render(<AgentProgression agentId="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('level-section')).toBeInTheDocument()
    })

    // XP to Level 7 = 1500 - 1278 = 222
    expect(screen.getByText(/XP to Level 7/)).toBeInTheDocument()
  })
})
