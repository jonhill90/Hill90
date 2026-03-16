import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { ProviderIcon, CompositeProviderIcon } from '@/app/harness/models/provider-icons'

describe('ProviderIcon', () => {
  afterEach(() => {
    cleanup()
  })

  // P1: ProviderIcon renders OpenAI icon with provider path (not fallback)
  it('P1: renders OpenAI icon with provider path', () => {
    const { container } = render(<ProviderIcon provider="openai" />)
    const svg = container.querySelector('svg[data-testid="provider-icon-openai"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'false')
    // Provider path contains <path> elements, not fallback <circle> elements
    expect(svg!.querySelector('path')).toBeInTheDocument()
    expect(svg!.querySelector('circle')).not.toBeInTheDocument()
  })

  // P2: ProviderIcon renders Anthropic icon with provider path (not fallback)
  it('P2: renders Anthropic icon with provider path', () => {
    const { container } = render(<ProviderIcon provider="anthropic" />)
    const svg = container.querySelector('svg[data-testid="provider-icon-anthropic"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'false')
    // Provider path contains <path> elements, not fallback <circle> elements
    expect(svg!.querySelector('path')).toBeInTheDocument()
    expect(svg!.querySelector('circle')).not.toBeInTheDocument()
  })

  // P3: ProviderIcon renders fallback for unknown provider
  it('P3: renders fallback for unknown provider with circle elements', () => {
    const { container } = render(<ProviderIcon provider="xai" />)
    const svg = container.querySelector('svg[data-testid="provider-icon-xai"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-fallback', 'true')
    // Fallback uses <circle> elements, not <path>
    expect(svg!.querySelector('circle')).toBeInTheDocument()
    expect(svg!.querySelector('path')).not.toBeInTheDocument()
  })

  // P4: All 6 known providers render without fallback
  it('P4: all 6 known providers render without fallback', () => {
    const providers = ['openai', 'anthropic', 'google', 'mistral', 'cohere', 'azure']
    for (const p of providers) {
      const { container, unmount } = render(<ProviderIcon provider={p} />)
      const svg = container.querySelector(`svg[data-testid="provider-icon-${p}"]`)
      expect(svg).toBeInTheDocument()
      expect(svg).toHaveAttribute('data-fallback', 'false')
      unmount()
    }
  })
})

describe('CompositeProviderIcon', () => {
  afterEach(() => {
    cleanup()
  })

  // P5: Single provider renders single icon, not composite
  it('P5: single provider renders single icon', () => {
    const { container } = render(<CompositeProviderIcon providers={['openai']} />)
    expect(container.querySelector('[data-testid="composite-provider-icon"]')).not.toBeInTheDocument()
    expect(container.querySelector('svg[data-testid="provider-icon-openai"]')).toBeInTheDocument()
  })

  // P6: Two providers render side-by-side composite
  it('P6: two providers render side-by-side composite', () => {
    const { container } = render(<CompositeProviderIcon providers={['openai', 'anthropic']} />)
    const composite = container.querySelector('[data-testid="composite-provider-icon"]')
    expect(composite).toBeInTheDocument()
    const svgs = composite!.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)
  })

  // P7: Three providers render grid
  it('P7: three providers render grid', () => {
    const { container } = render(<CompositeProviderIcon providers={['openai', 'anthropic', 'google']} />)
    const composite = container.querySelector('[data-testid="composite-provider-icon"]')
    expect(composite).toBeInTheDocument()
    expect(composite!.className).toContain('grid')
    const svgs = composite!.querySelectorAll('svg')
    expect(svgs).toHaveLength(3)
  })

  // P8: Five providers render grid with overflow count
  it('P8: five providers render grid with overflow count', () => {
    const { container } = render(
      <CompositeProviderIcon providers={['openai', 'anthropic', 'google', 'mistral', 'cohere']} />
    )
    const composite = container.querySelector('[data-testid="composite-provider-icon"]')
    expect(composite).toBeInTheDocument()
    const svgs = composite!.querySelectorAll('svg')
    expect(svgs).toHaveLength(4)
    expect(composite!.textContent).toContain('+1')
  })
})
