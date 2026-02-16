'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import HillLogo from '@/components/HillLogo';

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'unhealthy' | 'loading';
  responseTime?: number;
}

export default function Dashboard() {
  const [services, setServices] = useState<ServiceHealth[]>([
    { name: 'API', status: 'loading' },
    { name: 'AI', status: 'loading' },
    { name: 'Auth', status: 'loading' },
    { name: 'MCP', status: 'loading' },
  ]);
  const [lastChecked, setLastChecked] = useState<string>('');

  const checkHealth = useCallback(async () => {
    setServices((prev) =>
      prev.map((s) => ({ ...s, status: 'loading' as const }))
    );
    try {
      const res = await fetch('/api/services/health');
      const data = await res.json();
      setServices(data.services);
      setLastChecked(new Date().toLocaleTimeString());
    } catch {
      setServices((prev) =>
        prev.map((s) => ({ ...s, status: 'unhealthy' as const }))
      );
      setLastChecked(new Date().toLocaleTimeString());
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
        <Link href="/" aria-label="Go to homepage" className="logo-link inline-flex items-center">
          <HillLogo width={120} className="logo-glow-hold" />
        </Link>
        <span className="text-sm font-medium text-white">Dashboard</span>
      </nav>

      {/* Content */}
      <main className="flex-1 px-6 py-12 max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Service Health</h1>
            {lastChecked && (
              <p className="text-sm text-mountain-400 mt-1">
                Last checked: {lastChecked}
              </p>
            )}
          </div>
          <button
            onClick={checkHealth}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          >
            Refresh
          </button>
        </div>

        {/* Health grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {services.map((svc) => (
            <div
              key={svc.name}
              className="rounded-lg border border-navy-700 bg-navy-800 p-5"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-white">{svc.name}</h3>
                <StatusBadge status={svc.status} />
              </div>
              {svc.responseTime !== undefined && (
                <p className="text-xs text-mountain-400">
                  Response: {svc.responseTime}ms
                </p>
              )}
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
        &copy; {new Date().getFullYear()} Hill90
      </footer>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-mountain-400">
        <span className="h-2 w-2 rounded-full bg-mountain-400 animate-pulse" />
        Checking
      </span>
    );
  }
  if (status === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-400">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
        Healthy
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
      <span className="h-2 w-2 rounded-full bg-red-500" />
      Unhealthy
    </span>
  );
}
