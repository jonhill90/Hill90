'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import SwaggerClient from './SwaggerClient'

export default function DocsApiPage() {
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
      <main className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">API Reference</h1>
          <p className="text-mountain-400 text-sm mt-1">Interactive documentation for the Hill90 REST API</p>
        </div>
        <SwaggerClient url="/api/docs/openapi" />
      </main>
    </AppShell>
  )
}
