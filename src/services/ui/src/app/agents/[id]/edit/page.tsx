import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import AgentEditClient from './AgentEditClient'

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) {
    redirect('/api/auth/signin')
  }

  const { id } = await params

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-3xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-8">Edit Agent</h1>
        <AgentEditClient agentId={id} />
      </main>
    </AppShell>
  )
}
