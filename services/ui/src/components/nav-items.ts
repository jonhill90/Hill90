import { Home, LayoutDashboard, Bot, FileText, Book, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavLink {
  type: 'link'
  id: string
  label: string
  href: string
  icon: LucideIcon
  adminOnly?: boolean
  external?: boolean
}

export interface NavGroup {
  type: 'group'
  id: string
  label: string
  icon: LucideIcon
  children: NavLink[]
}

export type NavItem = NavLink | NavGroup

export const NAV_ITEMS: NavItem[] = [
  { type: 'link', id: 'home', label: 'Home', href: '/', icon: Home },
  { type: 'link', id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { type: 'link', id: 'agents', label: 'Agents', href: '/agents', icon: Bot },
  {
    type: 'group',
    id: 'docs',
    label: 'Docs',
    icon: Book,
    children: [
      { type: 'link', id: 'api-docs', label: 'API Docs', href: '/docs/api', icon: FileText, adminOnly: true },
      { type: 'link', id: 'platform-docs', label: 'Platform Docs', href: 'https://docs.hill90.com', icon: ExternalLink, external: true },
    ],
  },
]
