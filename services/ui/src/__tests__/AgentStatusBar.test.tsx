import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentStatusBar from '@/app/chat/AgentStatusBar'

describe('AgentStatusBar', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when no agents', () => {
    const { container } = render(<AgentStatusBar agents={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders agent status items', () => {
    render(
      <AgentStatusBar
        agents={[
          { id: 'a1', agent_id: 'bot-1', name: 'Bot One', status: 'running' },
          { id: 'a2', agent_id: 'bot-2', name: 'Bot Two', status: 'stopped' },
        ]}
      />
    )
    expect(screen.getByTestId('agent-status-bar')).toBeInTheDocument()
    expect(screen.getAllByTestId('agent-status-item')).toHaveLength(2)
    expect(screen.getByText('Bot One')).toBeInTheDocument()
    expect(screen.getByText('Bot Two')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('stopped')).toBeInTheDocument()
  })

  it('uses agent_id as fallback when name is empty', () => {
    render(
      <AgentStatusBar
        agents={[
          { id: 'a1', agent_id: 'fallback-id', name: '', status: 'running' },
        ]}
      />
    )
    expect(screen.getByText('fallback-id')).toBeInTheDocument()
  })
})
