'use client'

import Link from 'next/link'
import { Users } from 'lucide-react'
import type { ChatThread } from './ChatLayout'

interface Props {
  threads: ChatThread[]
  loading: boolean
  activeThreadId?: string
  onDelete: (threadId: string) => void
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

export default function ThreadList({ threads, loading, activeThreadId, onDelete }: Props) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-mountain-400 text-sm">
        Loading...
      </div>
    )
  }

  if (threads.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-mountain-400 text-sm p-4 text-center">
        No conversations yet. Start a new chat to begin.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {threads.map(thread => {
        const isActive = thread.id === activeThreadId
        const isGroup = thread.type === 'group'
        const displayTitle = thread.title
          || (isGroup ? `Group (${thread.agent_count || 0} agents)` : thread.agent?.name || 'Chat')
        const preview = thread.last_message
          ? truncate(thread.last_message, 60)
          : 'No messages yet'
        const time = timeAgo(thread.updated_at || thread.created_at)

        return (
          <Link
            key={thread.id}
            href={`/chat/${thread.id}`}
            className={`block px-3 py-2.5 border-b border-navy-800 hover:bg-navy-800 transition-colors ${
              isActive ? 'bg-navy-800 border-l-2 border-l-brand-500' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {isGroup && (
                    <Users size={12} className="text-mountain-400 flex-shrink-0" data-testid="group-icon" />
                  )}
                  <span className="text-sm font-medium text-gray-200 truncate">
                    {displayTitle}
                  </span>
                  {!isGroup && thread.agent?.status === 'running' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0" />
                  )}
                </div>
                {isGroup && thread.agents && thread.agents.length > 0 && (
                  <p className="text-[10px] text-mountain-500 truncate mt-0.5" data-testid="agent-names">
                    {thread.agents.map(a => a.name).join(', ')}
                  </p>
                )}
                <p className="text-xs mt-0.5 truncate text-mountain-500">
                  {preview}
                </p>
              </div>
              <span className="text-xs text-mountain-500 flex-shrink-0 mt-0.5">{time}</span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
