'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { Menu, Bell, Bot, CheckCircle, AlertCircle, Play } from 'lucide-react'
import HillLogo from '@/components/HillLogo'
import AuthButtons from '@/components/AuthButtons'
import MobileDrawer from '@/components/MobileDrawer'

interface Notification {
  id: string
  type: 'success' | 'error' | 'info'
  title: string
  message: string
  agentName: string
  timestamp: string
  read: boolean
}

const MOCK_NOTIFICATIONS: Notification[] = [
  {
    id: 'n1',
    type: 'success',
    title: 'Task completed',
    message: 'Finished analyzing repository structure',
    agentName: 'ResearchBot',
    timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
    read: false,
  },
  {
    id: 'n2',
    type: 'info',
    title: 'Agent started',
    message: 'Container provisioned and running',
    agentName: 'CodeAssistant',
    timestamp: new Date(Date.now() - 12 * 60_000).toISOString(),
    read: false,
  },
  {
    id: 'n3',
    type: 'error',
    title: 'Inference error',
    message: 'Provider returned 429 — rate limit exceeded',
    agentName: 'WriterBot',
    timestamp: new Date(Date.now() - 45 * 60_000).toISOString(),
    read: false,
  },
  {
    id: 'n4',
    type: 'success',
    title: 'Agent stopped',
    message: 'Graceful shutdown complete',
    agentName: 'ResearchBot',
    timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
    read: true,
  },
  {
    id: 'n5',
    type: 'info',
    title: 'New chat message',
    message: 'Responded to your question about auth flow',
    agentName: 'CodeAssistant',
    timestamp: new Date(Date.now() - 5 * 3600_000).toISOString(),
    read: true,
  },
]

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function NotificationIcon({ type }: { type: Notification['type'] }) {
  switch (type) {
    case 'success':
      return <CheckCircle size={16} className="text-brand-400 flex-shrink-0" />
    case 'error':
      return <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
    case 'info':
      return <Play size={16} className="text-blue-400 flex-shrink-0" />
  }
}

interface TopBarProps {
  navExtra?: React.ReactNode
}

export default function TopBar({ navExtra }: TopBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState(MOCK_NOTIFICATIONS)
  const notifRef = useRef<HTMLDivElement>(null)
  const { data: session } = useSession()

  const unreadCount = notifications.filter(n => !n.read).length

  const closeNotif = useCallback(() => setNotifOpen(false), [])

  useEffect(() => {
    if (!notifOpen) return

    function handleMouseDown(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        closeNotif()
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeNotif()
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [notifOpen, closeNotif])

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }

  return (
    <>
      <header className="flex items-center justify-between px-4 py-3 border-b border-navy-700 bg-navy-900">
        {/* Left: hamburger + logo + breadcrumb */}
        <div className="flex items-center gap-3">
          {session && (
            <button
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              className="md:hidden text-mountain-400 hover:text-white transition-colors"
            >
              <Menu size={22} />
            </button>
          )}
          <Link href="/" aria-label="Go to homepage" className="logo-link inline-flex items-center">
            <HillLogo width={96} className="logo-glow-hold" />
          </Link>
          {navExtra && (
            <div className="hidden sm:flex items-center text-sm text-mountain-400">
              {navExtra}
            </div>
          )}
        </div>

        {/* Right: notifications + auth */}
        <div className="flex items-center gap-3">
          {session && (
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setNotifOpen(prev => !prev)}
                className="relative p-1.5 text-mountain-400 hover:text-white transition-colors rounded-md hover:bg-navy-700"
                aria-label="Notifications"
                aria-haspopup="true"
                aria-expanded={notifOpen}
                data-testid="notifications-bell"
              >
                <Bell size={20} />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 text-[10px] font-bold leading-4 text-center text-white bg-red-500 rounded-full">
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div
                  className="absolute right-0 top-full mt-2 z-50 bg-navy-800 border border-navy-700 rounded-lg shadow-lg w-80 max-h-96 overflow-hidden flex flex-col"
                  data-testid="notifications-dropdown"
                >
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-navy-700">
                    <h3 className="text-sm font-semibold text-white">Notifications</h3>
                    {unreadCount > 0 && (
                      <button
                        onClick={markAllRead}
                        className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                        data-testid="mark-all-read"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>

                  <div className="overflow-y-auto flex-1">
                    {notifications.map(n => (
                      <div
                        key={n.id}
                        className={`px-4 py-3 border-b border-navy-700/50 hover:bg-navy-700/30 transition-colors ${
                          !n.read ? 'bg-navy-700/10' : ''
                        }`}
                        data-testid="notification-item"
                      >
                        <div className="flex items-start gap-2.5">
                          <NotificationIcon type={n.type} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className={`text-sm font-medium truncate ${!n.read ? 'text-white' : 'text-mountain-400'}`}>
                                {n.title}
                              </p>
                              <span className="text-[10px] text-mountain-500 flex-shrink-0">
                                {formatRelative(n.timestamp)}
                              </span>
                            </div>
                            <p className="text-xs text-mountain-500 truncate mt-0.5">{n.message}</p>
                            <div className="flex items-center gap-1 mt-1">
                              <Bot size={10} className="text-mountain-500" />
                              <span className="text-[10px] text-mountain-500">{n.agentName}</span>
                            </div>
                          </div>
                          {!n.read && (
                            <span className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0 mt-1.5" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <AuthButtons />
        </div>
      </header>

      <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  )
}
