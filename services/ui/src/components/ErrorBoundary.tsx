'use client'

import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    // React #310 hydration errors are recoverable — retry render
    if (error.message?.includes('310') || error.message?.includes('Minified React error')) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return null
    }
    return this.props.children
  }
}
