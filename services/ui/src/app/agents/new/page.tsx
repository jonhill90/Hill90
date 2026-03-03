import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import AgentFormClient from './AgentFormClient'

export default async function NewAgentPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  const isAdmin = (session.user as any)?.roles?.includes('admin') ?? false

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-3xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-8">Create Agent</h1>
        <AgentFormClient isAdmin={isAdmin} />
      </main>
    </AppShell>
  )
}
