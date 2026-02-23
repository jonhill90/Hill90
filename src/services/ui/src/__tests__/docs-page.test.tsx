import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock swagger-ui-react
const MockSwaggerUI = vi.fn((props: any) => <div data-testid="swagger-ui" data-url={props.url} />)

vi.mock('swagger-ui-react', () => ({
  default: (props: any) => MockSwaggerUI(props),
}))

// Mock the CSS import
vi.mock('swagger-ui-react/swagger-ui.css', () => ({}))

// Mock next/dynamic to eagerly load the component (no SSR gating in tests)
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<any>) => {
    // Eagerly resolve the dynamic import
    const Component = React.lazy(loader)
    return (props: any) => (
      <React.Suspense fallback={null}>
        <Component {...props} />
      </React.Suspense>
    )
  },
}))

import SwaggerClient from '@/app/docs/api/SwaggerClient'

describe('SwaggerClient', () => {
  it('renders swagger-ui-react with url prop', async () => {
    const { findByTestId } = render(<SwaggerClient url="/api/docs/openapi" />)

    // Wait for the lazy-loaded component to resolve
    await findByTestId('swagger-ui')

    expect(MockSwaggerUI).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/docs/openapi' })
    )
  })
})
