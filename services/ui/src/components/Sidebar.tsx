'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ChevronsLeft, ChevronsRight, ChevronDown, ChevronRight } from 'lucide-react'
import { NAV_ITEMS } from '@/components/nav-items'
import type { NavItem, NavLink, NavGroup } from '@/components/nav-items'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('sidebar-collapsed') === 'true'
  } catch {
    return false
  }
}

function readExpandState(): Record<string, boolean> {
  const state: Record<string, boolean> = {}
  for (const item of NAV_ITEMS) {
    if (item.type === 'group') {
      try {
        const val = localStorage.getItem(`nav-expanded-${item.id}`)
        if (val === 'true') state[item.id] = true
      } catch { /* SSR / privacy mode */ }
    }
  }
  return state
}

export default function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [expanded, setExpanded] = useState(readExpandState)

  const roles: string[] = (session?.user as any)?.roles ?? []
  const isAdmin = roles.includes('admin')

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem('sidebar-collapsed', String(next))
      } catch { /* SSR / privacy mode */ }
      return next
    })
  }

  function toggleExpand(id: string) {
    if (collapsed) {
      setCollapsed(false)
      try {
        localStorage.setItem('sidebar-collapsed', 'false')
      } catch { /* SSR / privacy mode */ }
    }
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try {
        localStorage.setItem(`nav-expanded-${id}`, String(next[id]))
      } catch { /* SSR / privacy mode */ }
      return next
    })
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

  function renderLink(item: NavLink) {
    const isActive = isLinkActive(item.href)
    const Icon = item.icon

    if (item.external) {
      return (
        <a
          key={item.id}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 pl-10 text-sm font-medium transition-colors text-mountain-400 hover:bg-navy-800 hover:text-white`}
        >
          <Icon size={18} aria-hidden="true" />
          <span data-sidebar-label className={collapsed ? 'sr-only' : ''}>
            {item.label}
          </span>
        </a>
      )
    }

    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 pl-10 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-brand-500/15 text-brand-400'
            : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
        }`}
      >
        <Icon size={18} aria-hidden="true" />
        <span data-sidebar-label className={collapsed ? 'sr-only' : ''}>
          {item.label}
        </span>
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
          title={collapsed ? item.label : undefined}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full ${
            isActive
              ? 'bg-brand-500/15 text-brand-400'
              : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
          }`}
        >
          <Icon size={20} aria-hidden="true" />
          <span data-sidebar-label className={collapsed ? 'sr-only' : ''}>
            {item.label}
          </span>
          {!collapsed && (
            isExpanded
              ? <ChevronDown size={16} aria-hidden="true" data-chevron="down" className="ml-auto" />
              : <ChevronRight size={16} aria-hidden="true" data-chevron="right" className="ml-auto" />
          )}
        </button>
        {isExpanded && (
          <div id={`${item.id}-submenu`} role="group">
            {visibleChildren.map(renderLink)}
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

    const isActive = isLinkActive(item.href)
    const Icon = item.icon

    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-brand-500/15 text-brand-400'
            : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
        }`}
      >
        <Icon size={20} aria-hidden="true" />
        <span data-sidebar-label className={collapsed ? 'sr-only' : ''}>
          {item.label}
        </span>
      </Link>
    )
  }

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-navy-700 bg-navy-900 transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : 'w-[220px]'
      }`}
    >
      <nav className="flex-1 flex flex-col gap-1 px-2 py-4">
        {NAV_ITEMS.map(renderItem)}
      </nav>

      <button
        onClick={toggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex items-center justify-center border-t border-navy-700 py-3 text-mountain-400 hover:text-white transition-colors"
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
      </button>
    </aside>
  )
}
