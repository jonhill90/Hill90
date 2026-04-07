'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import { Zap } from 'lucide-react'
import AppShell from '@/components/AppShell'

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
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-white">Workflows</h1>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-400 border border-brand-500/30">
              Coming soon
            </span>
          </div>
          <p className="text-mountain-400">
            Define event-triggered agent workflows to automate multi-step tasks across your platform.
          </p>
        </div>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 flex flex-col items-center justify-center text-center">
          <div className="mb-4 rounded-full bg-navy-700 p-4">
            <Zap className="h-8 w-8 text-mountain-400" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">No workflows configured</h2>
          <p className="text-mountain-400 max-w-md">
            Workflows will let you chain agent actions with event triggers, schedules, and conditional logic.
          </p>
        </div>
      </main>
    </AppShell>
  )
}
