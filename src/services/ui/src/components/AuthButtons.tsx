'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSession, signIn } from "next-auth/react"
import Link from 'next/link'

function useAvatar() {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const fetchAvatar = useCallback(async () => {
    try {
      const res = await fetch('/api/profile/avatar')
      if (res.ok) {
        const blob = await res.blob()
        setAvatarUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
      } else {
        setAvatarUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return null
        })
      }
    } catch {
      setAvatarUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    fetchAvatar()

    function onAvatarChanged() {
      fetchAvatar()
    }
    window.addEventListener('avatar-changed', onAvatarChanged)

    return () => {
      window.removeEventListener('avatar-changed', onAvatarChanged)
    }
  }, [fetchAvatar])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setAvatarUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [])

  return { avatarUrl, loaded }
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('')
}

export default function AuthButtons() {
  const { data: session, status } = useSession()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<(HTMLAnchorElement | null)[]>([])

  const close = useCallback(() => setOpen(false), [])

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return

    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close()
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, close])

  // Focus first item when menu opens
  useEffect(() => {
    if (open) {
      itemsRef.current[0]?.focus()
    }
  }, [open])

  function handleMenuKeyDown(e: React.KeyboardEvent) {
    const items = itemsRef.current.filter(Boolean) as HTMLAnchorElement[]
    const currentIndex = items.indexOf(document.activeElement as HTMLAnchorElement)

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0
        items[next]?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1
        items[prev]?.focus()
        break
      }
      case 'Home':
        e.preventDefault()
        items[0]?.focus()
        break
      case 'End':
        e.preventDefault()
        items[items.length - 1]?.focus()
        break
      case 'Tab':
        close()
        break
    }
  }

  if (status === "loading") {
    return (
      <div
        className="h-9 w-9 rounded-full bg-navy-800 animate-pulse"
        role="status"
        aria-label="Loading user information"
      />
    )
  }

  const { avatarUrl, loaded: avatarLoaded } = useAvatar()

  if (session) {
    const name = session.user?.name || ''
    const initials = getInitials(name)

    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setOpen(prev => !prev)}
          className="h-9 w-9 rounded-full bg-brand-500 flex items-center justify-center text-sm font-semibold text-white select-none cursor-pointer overflow-hidden"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="User menu"
          title={name}
        >
          {avatarLoaded && avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={() => {/* fallback handled by useAvatar */}}
            />
          ) : (
            initials || (
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2v-1.2c0-3.2-6.4-4.8-9.6-4.8z" />
              </svg>
            )
          )}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-50 bg-navy-800 border border-navy-700 rounded-lg shadow-lg py-1 min-w-[160px]"
            onKeyDown={handleMenuKeyDown}
          >
            <Link
              href="/profile"
              role="menuitem"
              tabIndex={-1}
              ref={el => { itemsRef.current[0] = el }}
              className="block px-4 py-2 text-sm text-mountain-400 hover:bg-navy-700 hover:text-white transition-colors"
              onClick={close}
            >
              Profile
            </Link>
            <Link
              href="/settings"
              role="menuitem"
              tabIndex={-1}
              ref={el => { itemsRef.current[1] = el }}
              className="block px-4 py-2 text-sm text-mountain-400 hover:bg-navy-700 hover:text-white transition-colors"
              onClick={close}
            >
              Settings
            </Link>
            <div role="separator" className="border-t border-navy-700 my-1" />
            <a
              href="/api/auth/federated-logout"
              role="menuitem"
              tabIndex={-1}
              ref={el => { itemsRef.current[2] = el }}
              className="block px-4 py-2 text-sm text-mountain-400 hover:bg-navy-700 hover:text-white transition-colors"
            >
              Sign out
            </a>
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => signIn("keycloak")}
      className="h-9 w-9 rounded-full bg-navy-800 border border-navy-700 flex items-center justify-center hover:border-mountain-500 hover:text-white transition-colors group"
      aria-label="Sign in"
    >
      <svg className="h-5 w-5 text-mountain-400 group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2v-1.2c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    </button>
  )
}
