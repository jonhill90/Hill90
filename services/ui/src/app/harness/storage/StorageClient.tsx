'use client'

import React from 'react'
import { HardDrive } from 'lucide-react'

const BUCKETS = [
  { name: 'agent-avatars', description: 'Agent profile images', status: 'active' },
  { name: 'agent-artifacts', description: 'Build outputs and agent-generated files', status: 'active' },
  { name: 'backups', description: 'Automated database and config backups', status: 'active' },
]

export default function StorageClient() {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <HardDrive className="h-6 w-6 text-brand-400" />
        <h1 className="text-2xl font-bold text-white">Storage</h1>
      </div>

      <p className="text-sm text-mountain-400 mb-6">
        MinIO object storage buckets used by the platform.
      </p>

      <div className="space-y-3">
        {BUCKETS.map(bucket => (
          <div
            key={bucket.name}
            className="rounded-lg border border-navy-700 bg-navy-800 p-4 flex items-center justify-between"
          >
            <div>
              <h3 className="text-sm font-medium text-white">{bucket.name}</h3>
              <p className="text-xs text-mountain-400 mt-0.5">{bucket.description}</p>
            </div>
            <span className="px-2 py-0.5 text-xs rounded-md border bg-brand-900/50 text-brand-400 border-brand-700">
              {bucket.status}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-lg border border-navy-700 bg-navy-800/50 p-6 text-center">
        <p className="text-sm text-mountain-500">
          Bucket browsing, upload, and usage metrics coming soon.
        </p>
      </div>
    </div>
  )
}
