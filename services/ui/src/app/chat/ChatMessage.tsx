'use client'

import { Bot, User, AlertCircle, Loader2 } from 'lucide-react'
import type { Message } from './ChatView'
import type { ChatAgent } from './ChatLayout'

interface Props {
  message: Message
  isOwnMessage: boolean
  isGroup?: boolean
  agents?: ChatAgent[]
  triggerAgentName?: string
}

// Stable color set for agent badges
const AGENT_COLORS = [
  'bg-blue-600/20 text-blue-400 border-blue-600/30',
  'bg-purple-600/20 text-purple-400 border-purple-600/30',
  'bg-amber-600/20 text-amber-400 border-amber-600/30',
  'bg-emerald-600/20 text-emerald-400 border-emerald-600/30',
  'bg-rose-600/20 text-rose-400 border-rose-600/30',
  'bg-cyan-600/20 text-cyan-400 border-cyan-600/30',
  'bg-orange-600/20 text-orange-400 border-orange-600/30',
  'bg-indigo-600/20 text-indigo-400 border-indigo-600/30',
]

function getAgentColor(agentId: string, agents: ChatAgent[]): string {
  const idx = agents.findIndex(a => a.id === agentId)
  return AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : 0]
}

export default function ChatMessage({ message, isOwnMessage, isGroup, agents = [], triggerAgentName }: Props) {
  const isUser = message.role === 'user'
  const isPending = message.status === 'pending'
  const isError = message.status === 'error'

  // In group threads, find the agent name for assistant messages
  const agentName = !isUser && isGroup
    ? agents.find(a => a.id === message.author_id)?.name || 'Agent'
    : null

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
          isUser ? 'bg-brand-600/30' : 'bg-navy-700'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-brand-400" />
        ) : (
          <Bot size={14} className="text-mountain-400" />
        )}
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[75%] rounded-xl px-3.5 py-2.5 ${
          isUser
            ? 'bg-brand-600/20 border border-brand-600/30'
            : isError
            ? 'bg-red-900/20 border border-red-800/30'
            : 'bg-navy-800 border border-navy-700'
        }`}
      >
        {/* Agent name badge for group threads */}
        {agentName && (
          <div className="mb-1.5" data-testid="agent-badge">
            <span
              className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded border ${
                getAgentColor(message.author_id, agents)
              }`}
            >
              {agentName}
            </span>
          </div>
        )}

        {/* Chain provenance annotation */}
        {message.triggered_by && (
          <div className="mb-1 text-[10px] text-mountain-500 italic" data-testid="chain-provenance">
            Triggered by @{triggerAgentName || 'agent'}
          </div>
        )}

        {isPending ? (
          <div className="flex items-center gap-2 text-mountain-400">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-sm italic">
              {agentName ? `${agentName} is thinking...` : 'Thinking...'}
            </span>
          </div>
        ) : isError ? (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-red-400">
                {message.error_message || 'An error occurred'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
            {message.content}
          </p>
        )}

        {/* Metadata for assistant messages */}
        {!isUser && message.status === 'complete' && (message.model || message.duration_ms) && (
          <div className="flex items-center gap-2 mt-1.5 text-xs text-mountain-500">
            {message.model && <span>{message.model}</span>}
            {message.duration_ms != null && (
              <span>{(message.duration_ms / 1000).toFixed(1)}s</span>
            )}
            {message.input_tokens != null && message.output_tokens != null && (
              <span>{message.input_tokens + message.output_tokens} tok</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
