'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import StorageClient from './StorageClient'

export default function StoragePage() {
  const { data: session, status } = useSession()

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-navy-900">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!session) {
    redirect('/api/auth/signin')
  }

  const isAdmin = (session.user as any)?.roles?.includes('admin')

  if (!isAdmin) {
    return (
      <AppShell>
        <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
          <div className="rounded-lg border border-red-700 bg-red-900/20 p-12 text-center">
            <p className="text-red-400 font-medium">Access denied</p>
            <p className="text-sm text-mountain-400 mt-2">
              You need admin privileges to view storage management.
            </p>
          </div>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <StorageClient />
      </main>
    </AppShell>
  )
}
