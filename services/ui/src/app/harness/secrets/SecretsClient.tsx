'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { ChevronDown, ChevronRight, KeyRound, Shield, ShieldOff, ShieldAlert } from 'lucide-react'

interface KeyEntry {
  key: string
  consumers: string[]
}

interface VaultPathGroup {
  path: string
  keys: KeyEntry[]
  keyCount: number
}

interface SecretsInventory {
  paths: VaultPathGroup[]
  totalPaths: number
  totalKeys: number
  approleServices: string[]
}

interface VaultStatus {
  available: boolean
  sealed: boolean | null
  initialized: boolean | null
  version: string | null
  cluster_name: string | null
}

function consumerBadge(service: string) {
  const colors: Record<string, string> = {
    db: 'bg-blue-900/50 text-blue-400 border-blue-700',
    api: 'bg-brand-900/50 text-brand-400 border-brand-700',
    ai: 'bg-purple-900/50 text-purple-400 border-purple-700',
    auth: 'bg-amber-900/50 text-amber-400 border-amber-700',
    ui: 'bg-cyan-900/50 text-cyan-400 border-cyan-700',
    knowledge: 'bg-emerald-900/50 text-emerald-400 border-emerald-700',
    minio: 'bg-orange-900/50 text-orange-400 border-orange-700',
    infra: 'bg-red-900/50 text-red-400 border-red-700',
    observability: 'bg-pink-900/50 text-pink-400 border-pink-700',
  }
  const classes = colors[service] || 'bg-navy-700/50 text-gray-400 border-navy-600'
  return (
    <span key={service} className={`inline-block px-2 py-0.5 text-xs rounded border ${classes}`}>
      {service}
    </span>
  )
}

function VaultStatusBar({ status }: { status: VaultStatus | null }) {
  if (!status) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-navy-800 border border-navy-700 mb-6">
        <div className="h-4 w-4 rounded-full bg-navy-600 animate-pulse" />
        <span className="text-sm text-gray-400">Loading vault status...</span>
      </div>
    )
  }

  if (!status.available) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-navy-800 border border-red-800/50 mb-6">
        <ShieldAlert className="h-4 w-4 text-red-400" />
        <span className="text-sm text-red-400">Vault unreachable</span>
        <span className="text-xs text-gray-500 ml-auto">Status endpoint unavailable</span>
      </div>
    )
  }

  if (status.sealed) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-navy-800 border border-amber-800/50 mb-6">
        <ShieldOff className="h-4 w-4 text-amber-400" />
        <span className="text-sm text-amber-400">Vault sealed</span>
        {status.version && <span className="text-xs text-gray-500 ml-auto">v{status.version}</span>}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-navy-800 border border-brand-800/50 mb-6">
      <Shield className="h-4 w-4 text-brand-400" />
      <span className="text-sm text-brand-400">Vault unsealed</span>
      {status.version && <span className="text-xs text-gray-500">v{status.version}</span>}
      {status.cluster_name && <span className="text-xs text-gray-500">({status.cluster_name})</span>}
    </div>
  )
}

function PathRow({ group }: { group: VaultPathGroup }) {
  const [expanded, setExpanded] = useState(false)

  const allConsumers = [...new Set(group.keys.flatMap(k => k.consumers))].sort()

  return (
    <>
      <tr
        className="border-b border-navy-700/50 hover:bg-navy-800/50 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded
              ? <ChevronDown className="h-4 w-4 text-gray-500 flex-shrink-0" />
              : <ChevronRight className="h-4 w-4 text-gray-500 flex-shrink-0" />
            }
            <code className="text-sm text-mountain-400 font-mono">{group.path}</code>
          </div>
        </td>
        <td className="px-4 py-3">
          <span className="inline-block px-2 py-0.5 text-xs rounded bg-navy-700 text-gray-300 border border-navy-600">
            {group.keyCount} {group.keyCount === 1 ? 'key' : 'keys'}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {allConsumers.map(s => consumerBadge(s))}
            {allConsumers.length === 0 && <span className="text-xs text-gray-600">none</span>}
          </div>
        </td>
      </tr>
      {expanded && group.keys.map(k => (
        <tr key={k.key} className="border-b border-navy-800/30 bg-navy-900/50">
          <td className="pl-12 pr-4 py-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3 w-3 text-gray-600" />
              <code className="text-xs text-gray-400 font-mono">{k.key}</code>
            </div>
          </td>
          <td className="px-4 py-2" />
          <td className="px-4 py-2">
            <div className="flex flex-wrap gap-1">
              {k.consumers.map(s => consumerBadge(s))}
              {k.consumers.length === 0 && <span className="text-xs text-gray-600">-</span>}
            </div>
          </td>
        </tr>
      ))}
    </>
  )
}

export default function SecretsClient() {
  const { data: session } = useSession()
  const isAdmin = (session?.user as any)?.roles?.includes('admin')

  const [inventory, setInventory] = useState<SecretsInventory | null>(null)
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [invRes, statusRes] = await Promise.all([
        fetch('/api/admin/secrets'),
        fetch('/api/admin/secrets/status'),
      ])
      if (invRes.ok) {
        setInventory(await invRes.json())
      } else {
        setError('Failed to load secrets inventory')
      }
      if (statusRes.ok) {
        setVaultStatus(await statusRes.json())
      }
    } catch (err) {
      setError('Failed to connect to API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) fetchData()
    else setLoading(false)
  }, [isAdmin, fetchData])

  if (!isAdmin) {
    return (
      <div className="text-center py-20">
        <ShieldOff className="h-12 w-12 text-red-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Access Denied</h2>
        <p className="text-gray-400">Secrets management requires admin privileges.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <ShieldAlert className="h-12 w-12 text-red-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Error</h2>
        <p className="text-gray-400">{error}</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Secrets</h1>
        <p className="text-sm text-gray-400 mt-1">
          Vault secrets inventory and metadata. Values are never displayed.
        </p>
      </div>

      <VaultStatusBar status={vaultStatus} />

      {inventory && (
        <>
          <div className="flex items-center gap-4 mb-4 text-sm text-gray-400">
            <span>{inventory.totalPaths} vault paths</span>
            <span>{inventory.totalKeys} total keys</span>
            <span>{inventory.approleServices.length} AppRole services</span>
          </div>

          <div className="rounded-lg border border-navy-700 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-navy-800 border-b border-navy-700">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Path</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Keys</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Consumers</th>
                </tr>
              </thead>
              <tbody>
                {inventory.paths.map(group => (
                  <PathRow key={group.path} group={group} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
