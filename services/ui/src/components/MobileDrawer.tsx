'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { X } from 'lucide-react'
import { NAV_ITEMS } from '@/components/nav-items'

interface MobileDrawerProps {
  open: boolean
  onClose: () => void
}

export default function MobileDrawer({ open, onClose }: MobileDrawerProps) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const prevPathname = useRef(pathname)

  const roles: string[] = (session?.user as any)?.roles ?? []
  const isAdmin = roles.includes('admin')
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin)

  // Close on route change
  useEffect(() => {
    if (prevPathname.current !== pathname && open) {
      onClose()
    }
    prevPathname.current = pathname
  }, [pathname, open, onClose])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  // Body scroll lock
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  return (
    <div className="md:hidden fixed inset-0 z-40">
      {/* Backdrop */}
      <div
        data-testid="mobile-drawer-backdrop"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Panel */}
      <nav className="relative z-50 flex flex-col w-[260px] h-full bg-navy-900 border-r border-navy-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-4 border-b border-navy-700">
          <span className="text-sm font-semibold text-white">Menu</span>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="text-mountain-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 flex flex-col gap-1 px-2 py-4">
          {items.map((item) => {
            const isActive = pathname === item.href
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-500/15 text-brand-400'
                    : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
                }`}
              >
                <Icon size={20} aria-hidden="true" />
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
