'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Plus,
  Shield,
  ShieldOff,
  ShieldAlert,
  Trash2,
  Save,
  X,
  Pencil,
} from 'lucide-react'

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

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-navy-800 border border-navy-600 rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
        <p className="text-sm text-gray-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white rounded border border-navy-600 hover:border-navy-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function SecretForm({
  initialPath,
  initialKey,
  onSave,
  onCancel,
  saving,
}: {
  initialPath?: string
  initialKey?: string
  onSave: (path: string, key: string, value: string) => void
  onCancel: () => void
  saving: boolean
}) {
  const [path, setPath] = useState(initialPath || '')
  const [key, setKey] = useState(initialKey || '')
  const [value, setValue] = useState('')

  const isEditing = !!initialKey

  return (
    <div className="bg-navy-800 border border-navy-600 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white">
          {isEditing ? `Update ${initialPath}/${initialKey}` : 'Add Secret'}
        </h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Vault Path</label>
          <input
            type="text"
            value={path}
            onChange={e => setPath(e.target.value)}
            disabled={isEditing}
            placeholder="secret/shared/database"
            className="w-full px-3 py-2 text-sm bg-navy-900 border border-navy-600 rounded text-white placeholder-gray-600 focus:outline-none focus:border-brand-500 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Key</label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            disabled={isEditing}
            placeholder="DB_PASSWORD"
            className="w-full px-3 py-2 text-sm bg-navy-900 border border-navy-600 rounded text-white placeholder-gray-600 focus:outline-none focus:border-brand-500 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Value</label>
          <input
            type="password"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Enter secret value"
            className="w-full px-3 py-2 text-sm bg-navy-900 border border-navy-600 rounded text-white placeholder-gray-600 focus:outline-none focus:border-brand-500"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded border border-navy-600 hover:border-navy-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(path, key, value)}
            disabled={saving || !path || !key || !value}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-brand-600 hover:bg-brand-500 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PathRow({
  group,
  onEdit,
  onDelete,
}: {
  group: VaultPathGroup
  onEdit: (path: string, key: string) => void
  onDelete: (path: string, key: string) => void
}) {
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
        <td className="px-4 py-3" />
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
          <td className="px-4 py-2">
            <div className="flex items-center gap-1 justify-end">
              <button
                onClick={e => { e.stopPropagation(); onEdit(group.path, k.key) }}
                className="p-1 text-gray-600 hover:text-brand-400 transition-colors"
                title="Update value"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(group.path, k.key) }}
                className="p-1 text-gray-600 hover:text-red-400 transition-colors"
                title="Delete key"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
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
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // CRUD state
  const [showForm, setShowForm] = useState(false)
  const [editTarget, setEditTarget] = useState<{ path: string; key: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; key: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }, [])

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
    } catch {
      setError('Failed to connect to API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) fetchData()
    else setLoading(false)
  }, [isAdmin, fetchData])

  const handleSave = async (path: string, key: string, value: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/admin/secrets/kv', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, key, value }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast('error', data.detail || data.error || 'Save failed')
        return
      }
      showToast('success', `Saved ${path}/${key}`)
      setShowForm(false)
      setEditTarget(null)
      fetchData()
    } catch {
      showToast('error', 'Failed to save secret')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/secrets/kv', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: deleteTarget.path, key: deleteTarget.key }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast('error', data.detail || data.error || 'Delete failed')
        return
      }
      showToast('success', `Deleted ${deleteTarget.path}/${deleteTarget.key}`)
      setDeleteTarget(null)
      fetchData()
    } catch {
      showToast('error', 'Failed to delete secret')
    } finally {
      setSaving(false)
    }
  }

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
      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg text-sm shadow-lg border transition-opacity ${
            toast.type === 'success'
              ? 'bg-brand-900/80 text-brand-300 border-brand-700'
              : 'bg-red-900/80 text-red-300 border-red-700'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <ConfirmDialog
          message={`Delete key "${deleteTarget.key}" from ${deleteTarget.path}? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Secrets</h1>
          <p className="text-sm text-gray-400 mt-1">
            Vault secrets inventory. Values are write-only — never displayed.
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditTarget(null) }}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Secret
        </button>
      </div>

      <VaultStatusBar status={vaultStatus} />

      {/* Add / Edit form */}
      {(showForm || editTarget) && (
        <SecretForm
          initialPath={editTarget?.path}
          initialKey={editTarget?.key}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditTarget(null) }}
          saving={saving}
        />
      )}

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
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase tracking-wider w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inventory.paths.map(group => (
                  <PathRow
                    key={group.path}
                    group={group}
                    onEdit={(p, k) => setEditTarget({ path: p, key: k })}
                    onDelete={(p, k) => setDeleteTarget({ path: p, key: k })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
