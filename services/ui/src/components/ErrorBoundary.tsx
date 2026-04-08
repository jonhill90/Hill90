'use client'

import React from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center px-6 py-24">
          <div className="text-center max-w-md">
            <AlertTriangle size={40} className="text-red-400 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-white mb-2">Something went wrong</h2>
            <p className="text-sm text-mountain-400 mb-6">
              An unexpected error occurred while rendering this page. You can try again or navigate elsewhere.
            </p>
            {this.state.error && (
              <p className="text-xs text-mountain-600 font-mono bg-navy-900 rounded-md px-3 py-2 mb-6 break-all border border-navy-700">
                {this.state.error.message}
              </p>
            )}
            <button
              onClick={this.handleReset}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
