import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ProfileClient from './ProfileClient'

export default async function Profile() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell navExtra={<span className="text-sm font-medium text-white">Profile</span>}>
      <main className="flex-1 px-6 py-12 max-w-2xl mx-auto w-full">
        <ProfileClient session={session} />
      </main>
    </AppShell>
  )
}
