'use client'

import { Crown } from 'lucide-react'

interface Agent {
  id: string
  agent_id: string
  name: string
  status: string
}

interface Props {
  agents: Agent[]
  leadAgentId?: string | null
}

export default function AgentStatusBar({ agents, leadAgentId }: Props) {
  if (agents.length === 0) return null

  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="agent-status-bar">
      {agents.map(agent => {
        const isLead = leadAgentId === agent.id
        return (
          <div
            key={agent.id}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs ${
              isLead
                ? 'bg-amber-900/30 border border-amber-700/50'
                : 'bg-navy-800 border border-navy-700'
            }`}
            data-testid="agent-status-item"
          >
            {isLead && (
              <Crown size={10} className="text-amber-400 flex-shrink-0" data-testid="lead-crown" />
            )}
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                agent.status === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
              }`}
            />
            <span className={isLead ? 'text-amber-300' : 'text-mountain-300'}>
              {agent.name || agent.agent_id}
            </span>
            <span className="text-mountain-500">
              {agent.status === 'running' ? 'running' : 'stopped'}
            </span>
          </div>
        )
      })}
    </div>
  )
}
