'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AdminServicesClient from './AdminServicesClient'

export default function AdminServicesPage() {
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

  return (
    <AppShell>
      <main className="flex-1 p-6">
        <AdminServicesClient />
      </main>
    </AppShell>
  )
}
