'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { HardDrive, FolderOpen, File, ChevronRight, ArrowLeft, RefreshCw, Upload, Trash2 } from 'lucide-react'

interface Bucket {
  name: string
  created_at: string
}

interface StorageObject {
  key: string
  size: number
  last_modified: string
  etag: string
}

interface ObjectsResponse {
  objects: StorageObject[]
  prefixes: string[]
  is_truncated: boolean
  next_continuation_token: string | null
  key_count: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function StorageClient() {
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Object browser state
  const [activeBucket, setActiveBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [objects, setObjects] = useState<StorageObject[]>([])
  const [prefixes, setPrefixes] = useState<string[]>([])
  const [objectsLoading, setObjectsLoading] = useState(false)
  const [objectsError, setObjectsError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchBuckets = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/storage/buckets')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to fetch buckets (${res.status})`)
      }
      setBuckets(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch buckets')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchObjects = useCallback(async (bucketName: string, objectPrefix: string) => {
    setObjectsLoading(true)
    setObjectsError(null)
    try {
      const params = new URLSearchParams()
      if (objectPrefix) params.set('prefix', objectPrefix)
      params.set('delimiter', '/')
      const url = `/api/storage/buckets/${bucketName}/objects${params.toString() ? `?${params}` : ''}`
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to fetch objects (${res.status})`)
      }
      const data: ObjectsResponse = await res.json()
      setObjects(data.objects)
      setPrefixes(data.prefixes)
    } catch (err) {
      setObjectsError(err instanceof Error ? err.message : 'Failed to fetch objects')
    } finally {
      setObjectsLoading(false)
    }
  }, [])

  const handleUpload = useCallback(async (files: FileList) => {
    if (!activeBucket || files.length === 0) return
    setUploading(true)
    setObjectsError(null)
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('key', prefix + file.name)
        const res = await fetch(`/api/storage/buckets/${activeBucket}/upload`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `Failed to upload ${file.name} (${res.status})`)
        }
      }
      fetchObjects(activeBucket, prefix)
    } catch (err) {
      setObjectsError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [activeBucket, prefix, fetchObjects])

  const handleDelete = useCallback(async (key: string) => {
    if (!activeBucket) return
    const fileName = key.replace(prefix, '')
    if (!confirm(`Delete "${fileName}"?`)) return
    setDeleting(key)
    setObjectsError(null)
    try {
      const res = await fetch(`/api/storage/buckets/${activeBucket}/objects/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to delete (${res.status})`)
      }
      fetchObjects(activeBucket, prefix)
    } catch (err) {
      setObjectsError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }, [activeBucket, prefix, fetchObjects])

  useEffect(() => {
    fetchBuckets()
  }, [fetchBuckets])

  useEffect(() => {
    if (activeBucket) {
      fetchObjects(activeBucket, prefix)
    }
  }, [activeBucket, prefix, fetchObjects])

  const openBucket = (name: string) => {
    setActiveBucket(name)
    setPrefix('')
    setObjects([])
    setPrefixes([])
  }

  const navigateToPrefix = (newPrefix: string) => {
    setPrefix(newPrefix)
  }

  const navigateUp = () => {
    // Remove last path segment: "a/b/c/" -> "a/b/"
    const parts = prefix.replace(/\/$/, '').split('/')
    parts.pop()
    setPrefix(parts.length > 0 ? parts.join('/') + '/' : '')
  }

  const backToBuckets = () => {
    setActiveBucket(null)
    setPrefix('')
    setObjects([])
    setPrefixes([])
    setObjectsError(null)
  }

  // Build breadcrumb segments from prefix
  const breadcrumbs = prefix
    ? prefix
        .replace(/\/$/, '')
        .split('/')
        .map((segment, i, arr) => ({
          label: segment,
          prefix: arr.slice(0, i + 1).join('/') + '/',
        }))
    : []

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  // Object browser view
  if (activeBucket) {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={backToBuckets}
            className="p-1.5 rounded-md text-mountain-400 hover:text-white hover:bg-navy-700 transition-colors cursor-pointer"
            title="Back to buckets"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <HardDrive className="h-6 w-6 text-brand-400" />
          <h1 className="text-2xl font-bold text-white">{activeBucket}</h1>
          <div className="ml-auto flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && handleUpload(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
            <button
              onClick={() => fetchObjects(activeBucket, prefix)}
              className="p-1.5 rounded-md text-mountain-400 hover:text-white hover:bg-navy-700 transition-colors cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1 text-sm mb-4 text-mountain-400 flex-wrap">
          <button
            onClick={() => setPrefix('')}
            className="hover:text-white transition-colors cursor-pointer"
          >
            {activeBucket}
          </button>
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.prefix} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              {i === breadcrumbs.length - 1 ? (
                <span className="text-white">{crumb.label}</span>
              ) : (
                <button
                  onClick={() => navigateToPrefix(crumb.prefix)}
                  className="hover:text-white transition-colors cursor-pointer"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </nav>

        {/* Error state */}
        {objectsError && (
          <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 mb-4">
            <p className="text-sm text-red-400">{objectsError}</p>
          </div>
        )}

        {/* Loading */}
        {objectsLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          </div>
        ) : prefixes.length === 0 && objects.length === 0 && !objectsError ? (
          /* Empty state */
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
            <FolderOpen className="h-10 w-10 text-mountain-500 mx-auto mb-3" />
            <p className="text-mountain-400">
              {prefix ? 'This folder is empty' : 'This bucket is empty'}
            </p>
          </div>
        ) : (
          /* Objects table */
          <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-700 text-left text-mountain-400">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium w-28 text-right">Size</th>
                  <th className="px-4 py-3 font-medium w-48 text-right">Last Modified</th>
                  <th className="px-4 py-3 font-medium w-12"></th>
                </tr>
              </thead>
              <tbody>
                {/* Navigate up row */}
                {prefix && (
                  <tr
                    className="border-b border-navy-700/50 hover:bg-navy-700/30 cursor-pointer transition-colors"
                    onClick={navigateUp}
                  >
                    <td className="px-4 py-2.5" colSpan={4}>
                      <span className="flex items-center gap-2 text-mountain-400 hover:text-white">
                        <FolderOpen className="h-4 w-4 text-mountain-500" />
                        ..
                      </span>
                    </td>
                  </tr>
                )}

                {/* Folders (prefixes) */}
                {prefixes.map((p) => {
                  const folderName = p.replace(prefix, '').replace(/\/$/, '')
                  return (
                    <tr
                      key={p}
                      className="border-b border-navy-700/50 hover:bg-navy-700/30 cursor-pointer transition-colors"
                      onClick={() => navigateToPrefix(p)}
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2 text-white">
                          <FolderOpen className="h-4 w-4 text-brand-400" />
                          {folderName}/
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-mountain-500">--</td>
                      <td className="px-4 py-2.5 text-right text-mountain-500">--</td>
                      <td></td>
                    </tr>
                  )
                })}

                {/* Files (objects) */}
                {objects.map((obj) => {
                  const fileName = obj.key.replace(prefix, '')
                  return (
                    <tr
                      key={obj.key}
                      className="border-b border-navy-700/50 hover:bg-navy-700/30 transition-colors group"
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2 text-white">
                          <File className="h-4 w-4 text-mountain-400" />
                          {fileName}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-mountain-400">
                        {formatBytes(obj.size)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-mountain-400">
                        {formatDate(obj.last_modified)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => handleDelete(obj.key)}
                          disabled={deleting === obj.key}
                          className="p-1 rounded text-mountain-500 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-50 transition-all cursor-pointer"
                          title={`Delete ${fileName}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // Bucket list view
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <HardDrive className="h-6 w-6 text-brand-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Storage</h1>
            <p className="text-sm text-mountain-400 mt-0.5">
              {buckets.length} bucket{buckets.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <button
          onClick={fetchBuckets}
          className="p-2 rounded-md text-mountain-400 hover:text-white hover:bg-navy-700 transition-colors cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 mb-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {buckets.length === 0 && !error ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <HardDrive className="h-10 w-10 text-mountain-500 mx-auto mb-3" />
          <p className="text-mountain-400">No buckets found</p>
          <p className="text-xs text-mountain-500 mt-1">
            MinIO buckets will appear here once created.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {buckets.map((bucket) => (
            <button
              key={bucket.name}
              onClick={() => openBucket(bucket.name)}
              className="w-full text-left rounded-lg border border-navy-700 bg-navy-800 p-4 flex items-center justify-between hover:border-navy-600 hover:bg-navy-750 transition-colors cursor-pointer group"
            >
              <div className="flex items-center gap-3">
                <FolderOpen className="h-5 w-5 text-brand-400" />
                <div>
                  <h3 className="text-sm font-medium text-white group-hover:text-brand-400 transition-colors">
                    {bucket.name}
                  </h3>
                  <p className="text-xs text-mountain-500 mt-0.5">
                    Created {formatDate(bucket.created_at)}
                  </p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-mountain-500 group-hover:text-mountain-400 transition-colors" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
