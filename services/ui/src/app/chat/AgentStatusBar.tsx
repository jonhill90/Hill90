'use client'

interface Agent {
  id: string
  agent_id: string
  name: string
  status: string
}

interface Props {
  agents: Agent[]
}

export default function AgentStatusBar({ agents }: Props) {
  if (agents.length === 0) return null

  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="agent-status-bar">
      {agents.map(agent => (
        <div
          key={agent.id}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-navy-800 border border-navy-700 text-xs"
          data-testid="agent-status-item"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              agent.status === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
            }`}
          />
          <span className="text-mountain-300">{agent.name || agent.agent_id}</span>
          <span className="text-mountain-500">
            {agent.status === 'running' ? 'running' : 'stopped'}
          </span>
        </div>
      ))}
    </div>
  )
}
