'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { Session } from 'next-auth'
import ThreadList from './ThreadList'
import NewThreadDialog from './NewThreadDialog'
import ChatView from './ChatView'

export interface ChatAgent {
  id: string
  agent_id: string
  name: string
  status: string
}

export interface ChatThread {
  id: string
  type: string
  title: string | null
  created_by: string
  created_at: string
  updated_at: string
  last_message?: string | null
  last_author_type?: string | null
  agent_count?: number
  agents?: ChatAgent[]
  // Backward compat: single agent for direct threads
  agent?: ChatAgent
}

interface Props {
  session: Session
  activeThreadId?: string
}

export default function ChatLayout({ session, activeThreadId }: Props) {
  const router = useRouter()
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewThread, setShowNewThread] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch('/api/chat')
      if (res.ok) {
        const data = await res.json()
        setThreads(data)
      }
    } catch (err) {
      console.error('Failed to fetch threads:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  const handleThreadCreated = (threadId: string) => {
    setShowNewThread(false)
    fetchThreads()
    router.push(`/chat/${threadId}`)
  }

  const handleDeleteThread = async (threadId: string) => {
    try {
      const res = await fetch(`/api/chat/${threadId}`, { method: 'DELETE' })
      if (res.ok) {
        fetchThreads()
        if (activeThreadId === threadId) {
          router.push('/chat')
        }
      }
    } catch (err) {
      console.error('Failed to delete thread:', err)
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Thread list sidebar — desktop */}
      <div
        className={`${
          sidebarOpen ? 'w-72' : 'w-0'
        } transition-all duration-200 flex-shrink-0 border-r border-navy-700 bg-navy-900 overflow-hidden hidden lg:block`}
      >
        <div className="w-72 h-full flex flex-col">
          <div className="p-3 border-b border-navy-700 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-200">Threads</h2>
            <button
              onClick={() => setShowNewThread(true)}
              className="px-2 py-1 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded transition-colors"
            >
              + New
            </button>
          </div>
          <ThreadList
            threads={threads}
            loading={loading}
            activeThreadId={activeThreadId}
            onDelete={handleDeleteThread}
          />
        </div>
      </div>

      {/* Mobile sidebar toggle + thread list */}
      <div className="lg:hidden">
        {!activeThreadId && (
          <div className="w-full h-full flex flex-col bg-navy-900">
            <div className="p-3 border-b border-navy-700 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200">Threads</h2>
              <button
                onClick={() => setShowNewThread(true)}
                className="px-2 py-1 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded transition-colors"
              >
                + New
              </button>
            </div>
            <ThreadList
              threads={threads}
              loading={loading}
              activeThreadId={activeThreadId}
              onDelete={handleDeleteThread}
            />
          </div>
        )}
      </div>

      {/* Message pane (flex-1) */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeThreadId ? (
          <ChatView
            threadId={activeThreadId}
            session={session}
            thread={threads.find(t => t.id === activeThreadId)}
            onBack={() => router.push('/chat')}
            onThreadUpdated={fetchThreads}
          />
        ) : (
          <div className="hidden lg:flex flex-1 items-center justify-center text-mountain-400">
            <div className="text-center">
              <p className="text-lg mb-2">Select a thread or start a new conversation</p>
              <button
                onClick={() => setShowNewThread(true)}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors"
              >
                New Chat
              </button>
            </div>
          </div>
        )}
      </div>

      {/* New thread dialog */}
      {showNewThread && (
        <NewThreadDialog
          onClose={() => setShowNewThread(false)}
          onCreated={handleThreadCreated}
        />
      )}
    </div>
  )
}
