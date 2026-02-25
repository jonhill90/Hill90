'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { NAV_ITEMS } from '@/components/nav-items'
import type { NavItem, NavLink, NavGroup } from '@/components/nav-items'

interface MobileDrawerProps {
  open: boolean
  onClose: () => void
}

export default function MobileDrawer({ open, onClose }: MobileDrawerProps) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const prevPathname = useRef(pathname)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const roles: string[] = (session?.user as any)?.roles ?? []
  const isAdmin = roles.includes('admin')

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function isLinkActive(href: string): boolean {
    if (href === '/') return pathname === '/'
    return pathname === href || pathname.startsWith(href + '/')
  }

  function isGroupActive(group: NavGroup): boolean {
    return group.children.some((child) => !child.external && isLinkActive(child.href))
  }

  function filterChildren(children: NavLink[]): NavLink[] {
    return children.filter((child) => !child.adminOnly || isAdmin)
  }

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
    if (!open) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  function renderLink(item: NavLink, indented: boolean) {
    const isActive = isLinkActive(item.href)
    const Icon = item.icon

    if (item.external) {
      return (
        <a
          key={item.id}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 ${indented ? 'pl-10' : ''} text-sm font-medium transition-colors text-mountain-400 hover:bg-navy-800 hover:text-white`}
        >
          <Icon size={indented ? 18 : 20} aria-hidden="true" />
          {item.label}
        </a>
      )
    }

    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 ${indented ? 'pl-10' : ''} text-sm font-medium transition-colors ${
          isActive
            ? 'bg-brand-500/15 text-brand-400'
            : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
        }`}
      >
        <Icon size={indented ? 18 : 20} aria-hidden="true" />
        {item.label}
      </Link>
    )
  }

  function renderGroup(item: NavGroup) {
    const isActive = isGroupActive(item)
    const isExpanded = !!expanded[item.id]
    const Icon = item.icon
    const visibleChildren = filterChildren(item.children)

    return (
      <div key={item.id}>
        <button
          onClick={() => toggleExpand(item.id)}
          aria-expanded={isExpanded}
          aria-controls={`${item.id}-submenu`}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full ${
            isActive
              ? 'bg-brand-500/15 text-brand-400'
              : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
          }`}
        >
          <Icon size={20} aria-hidden="true" />
          {item.label}
          {isExpanded
            ? <ChevronDown size={16} aria-hidden="true" data-chevron="down" className="ml-auto" />
            : <ChevronRight size={16} aria-hidden="true" data-chevron="right" className="ml-auto" />
          }
        </button>
        {isExpanded && (
          <div id={`${item.id}-submenu`} role="group">
            {visibleChildren.map((child) => renderLink(child, true))}
          </div>
        )}
      </div>
    )
  }

  function renderItem(item: NavItem) {
    if (item.type === 'group') {
      return renderGroup(item)
    }

    if (item.adminOnly && !isAdmin) return null

    return renderLink(item, false)
  }

  return (
    <div
      className="md:hidden fixed inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation menu"
    >
      {/* Backdrop */}
      <div
        data-testid="mobile-drawer-backdrop"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Panel */}
      <nav id="mobile-nav" className="relative z-50 flex flex-col w-[260px] h-full bg-navy-900 border-r border-navy-700 shadow-xl">
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
          {NAV_ITEMS.map(renderItem)}
        </div>
      </nav>
    </div>
  )
}
