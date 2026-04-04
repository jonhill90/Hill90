'use client'

import { signIn } from 'next-auth/react'
import HillLogo from '@/components/HillLogo'

export default function LandingHero() {
  return (
    <div className="min-h-screen flex flex-col bg-navy-900">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <HillLogo width={160} className="mb-8" />

        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
          <span className="text-brand-500">Hill90</span>{' '}
          <span className="text-white">Platform</span>
        </h1>

        <p className="text-lg text-mountain-400 max-w-lg mb-10">
          Infrastructure automation, agent orchestration, and AI-powered
          workflows — all in one place.
        </p>

        <button
          onClick={() => signIn('keycloak')}
          className="px-8 py-3 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-base transition-colors"
          data-testid="landing-sign-in"
        >
          Sign in
        </button>
      </div>

      <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
        &copy; {new Date().getFullYear()} Hill90
      </footer>
    </div>
  )
}
