'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { Zap } from 'lucide-react'

export default function WorkflowsPage() {
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
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-3 mb-6">
          <Zap size={24} className="text-brand-400" />
          <h1 className="text-2xl font-bold">Workflows</h1>
        </div>
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
          <Zap size={40} className="text-mountain-500 mx-auto mb-4" />
          <p className="text-mountain-400 text-lg mb-2">Trigger agents automatically on events</p>
          <p className="text-mountain-500 text-sm">Coming soon</p>
        </div>
      </main>
    </AppShell>
  )
}
