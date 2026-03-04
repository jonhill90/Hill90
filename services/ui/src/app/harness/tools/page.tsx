import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ToolsClient from './ToolsClient'

export default async function ToolsPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <ToolsClient />
      </main>
    </AppShell>
  )
}
