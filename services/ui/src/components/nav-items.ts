import { Home, LayoutDashboard, Bot, FileText, Book, ExternalLink, KeyRound, Cpu, Shield, BarChart3, BookOpen, Library, Layers } from 'lucide-react'
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
    id: 'harness',
    label: 'Harness',
    icon: Layers,
    children: [
      { type: 'link', id: 'connections', label: 'Connections', href: '/harness/connections', icon: KeyRound },
      { type: 'link', id: 'models', label: 'Models', href: '/harness/models', icon: Cpu },
      { type: 'link', id: 'policies', label: 'Policies', href: '/harness/policies', icon: Shield },
      { type: 'link', id: 'usage', label: 'Usage', href: '/harness/usage', icon: BarChart3 },
      { type: 'link', id: 'knowledge', label: 'Knowledge', href: '/harness/knowledge', icon: BookOpen },
      { type: 'link', id: 'shared-knowledge', label: 'Shared Knowledge', href: '/harness/shared-knowledge', icon: Library },
    ],
  },
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
