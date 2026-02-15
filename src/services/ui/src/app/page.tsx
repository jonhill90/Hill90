import Image from 'next/image';
import Link from 'next/link';

const services = [
  {
    name: 'API Gateway',
    description: 'REST API routing, request validation, and service orchestration.',
    endpoint: 'api.hill90.com',
  },
  {
    name: 'AI Services',
    description: 'AI-powered endpoints for inference and intelligent processing.',
    endpoint: 'ai.hill90.com',
  },
  {
    name: 'Auth Service',
    description: 'Authentication, authorization, and session management.',
    endpoint: 'Internal',
  },
  {
    name: 'MCP Gateway',
    description: 'Model Context Protocol server for AI tool integrations.',
    endpoint: 'ai.hill90.com/mcp',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
        <Image
          src="/hill90-logo10.png"
          alt="Hill90"
          width={120}
          height={40}
          priority
        />
        <Link
          href="/dashboard"
          className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
        >
          Dashboard
        </Link>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
          <span className="text-brand-500">Hill90</span> Platform
        </h1>
        <p className="text-lg text-mountain-400 max-w-xl mb-12">
          A microservices platform with infrastructure automation,
          Tailscale-secured networking, and Docker Compose deployments.
        </p>

        {/* Services grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
          {services.map((svc) => (
            <div
              key={svc.name}
              className="rounded-lg border border-navy-700 bg-navy-800 p-5 text-left hover:border-brand-500/50 transition-colors"
            >
              <h3 className="font-semibold text-white mb-1">{svc.name}</h3>
              <p className="text-sm text-mountain-400 mb-3">{svc.description}</p>
              <span className="text-xs font-mono text-brand-400">{svc.endpoint}</span>
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
