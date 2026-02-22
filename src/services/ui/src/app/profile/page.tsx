import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import AppShell from '@/components/AppShell';

export default async function Profile() {
  const session = await auth();

  if (!session) {
    redirect('/api/auth/signin');
  }

  return (
    <AppShell navExtra={<span className="text-sm font-medium text-white">Profile</span>}>
      <main className="flex-1 px-6 py-12 max-w-2xl mx-auto w-full">
        <h1 className="text-2xl font-bold text-white mb-8">Profile</h1>

        <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 space-y-4">
          <div>
            <label className="text-xs font-medium text-mountain-500 uppercase tracking-wide">Name</label>
            <p className="text-white mt-1">{session.user?.name || 'Not set'}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-mountain-500 uppercase tracking-wide">Email</label>
            <p className="text-white mt-1">{session.user?.email || 'Not set'}</p>
          </div>
        </div>

        <div className="mt-8 rounded-lg border border-navy-700 bg-navy-800 p-6">
          <h2 className="text-lg font-semibold text-white mb-2">Profile Picture</h2>
          <p className="text-sm text-mountain-400">Coming soon.</p>
        </div>

        <div className="mt-4 rounded-lg border border-navy-700 bg-navy-800 p-6">
          <h2 className="text-lg font-semibold text-white mb-2">Change Password</h2>
          <p className="text-sm text-mountain-400">Coming soon.</p>
        </div>
      </main>
    </AppShell>
  );
}
