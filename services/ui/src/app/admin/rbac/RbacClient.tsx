'use client'

import { useState } from 'react'
import type { Session } from 'next-auth'
import { ShieldCheck, User, Users, Info } from 'lucide-react'

interface RoleDefinition {
  name: string
  description: string
  permissions: string[]
}

const PLATFORM_ROLES: RoleDefinition[] = [
  {
    name: 'admin',
    description: 'Full platform access. Can manage agents, secrets, services, and all user resources.',
    permissions: [
      'Manage all agents and containers',
      'View and manage secrets vault',
      'Access admin pages (Services, RBAC)',
      'Delete platform connections',
      'Assign elevated-scope skills',
      'View all chat threads',
    ],
  },
  {
    name: 'user',
    description: 'Standard authenticated user. Can create and manage own resources.',
    permissions: [
      'Create and manage own agents',
      'Create provider connections and models',
      'Use chat and terminal',
      'Search shared knowledge',
      'View own usage statistics',
    ],
  },
  {
    name: 'offline_access',
    description: 'Keycloak default. Allows refresh token usage for long-lived sessions.',
    permissions: ['Obtain refresh tokens for session persistence'],
  },
  {
    name: 'uma_authorization',
    description: 'Keycloak default. User-Managed Access for fine-grained resource authorization.',
    permissions: ['Request UMA permissions (not currently used)'],
  },
  {
    name: 'default-roles-hill90',
    description: 'Composite role assigned on user creation. Includes offline_access and uma_authorization.',
    permissions: ['Grants default Keycloak roles to new users'],
  },
]

export default function RbacClient({ session }: { session: Session }) {
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const userRoles: string[] = (session.user as any)?.roles || []
  const isAdmin = userRoles.includes('admin')

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
        <ShieldCheck className="w-12 h-12 text-mountain-500 mx-auto mb-4" />
        <p className="text-mountain-400">Admin access required to view RBAC settings.</p>
      </div>
    )
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Roles & Access Control</h1>
        <p className="text-sm text-mountain-400 mt-1">
          Keycloak realm roles and their platform permissions
        </p>
      </div>

      {/* Current user card */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <User className="w-5 h-5 text-brand-400" />
          <h2 className="text-sm font-semibold text-white">Your Roles</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {userRoles.length > 0 ? (
            userRoles.map((role) => (
              <span
                key={role}
                className={`inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-md ${
                  role === 'admin'
                    ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                    : 'bg-navy-700 text-mountain-400 border border-navy-600'
                }`}
              >
                {role}
              </span>
            ))
          ) : (
            <span className="text-sm text-mountain-500">No roles assigned</span>
          )}
        </div>
      </div>

      {/* Roles table */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-navy-700 flex items-center gap-2">
          <Users className="w-4 h-4 text-mountain-400" />
          <h2 className="text-sm font-semibold text-white">Platform Roles</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-mountain-400 text-left border-b border-navy-700">
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Description</th>
              <th className="px-5 py-3 font-medium text-center">You</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORM_ROLES.map((role) => {
              const hasRole = userRoles.includes(role.name)
              const isExpanded = expandedRole === role.name
              return (
                <tr
                  key={role.name}
                  className="border-t border-navy-700 cursor-pointer hover:bg-navy-700/30 transition-colors"
                  onClick={() => setExpandedRole(isExpanded ? null : role.name)}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-white">{role.name}</span>
                      <Info className="w-3.5 h-3.5 text-mountain-500" />
                    </div>
                    {isExpanded && (
                      <ul className="mt-2 space-y-1 text-xs text-mountain-400">
                        {role.permissions.map((perm, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-mountain-500 mt-0.5">-</span>
                            {perm}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-5 py-3 text-mountain-400">{role.description}</td>
                  <td className="px-5 py-3 text-center">
                    {hasRole ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-400">
                        <span className="h-2 w-2 rounded-full bg-brand-500" />
                        Yes
                      </span>
                    ) : (
                      <span className="text-xs text-mountain-500">No</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 rounded-lg border border-navy-700/50 bg-navy-800/50 p-4">
        <p className="text-xs text-mountain-500">
          Roles are managed in Keycloak. Changes to role assignments require Keycloak admin access.
          Platform roles (admin, user) control access to Hill90 features. Default Keycloak roles
          (offline_access, uma_authorization) are assigned automatically on user creation.
        </p>
      </div>
    </>
  )
}
