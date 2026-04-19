import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['user'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/mcp-servers',
}))

import McpServersClient from '@/app/harness/mcp-servers/McpServersClient'

const MOCK_SERVERS = [
  {
    id: 's1',
    name: 'GitHub MCP',
    description: 'GitHub API tools',
    transport: 'stdio',
    connection_config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    is_platform: false,
    agent_count: 2,
    created_by: 'user1',
    created_at: new Date().toISOString(),
  },
  {
    id: 's2',
    name: 'Knowledge Server',
    description: null,
    transport: 'sse',
    connection_config: { url: 'http://localhost:3001/mcp' },
    is_platform: true,
    agent_count: 0,
    created_by: 'system',
    created_at: new Date().toISOString(),
  },
]

describe('McpServersClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders page title and description', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('MCP Servers')).toBeInTheDocument()
    })
    expect(screen.getByText(/model context protocol/i)).toBeInTheDocument()
  })

  it('renders server list after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('GitHub MCP')).toBeInTheDocument()
    })
    expect(screen.getByText('Knowledge Server')).toBeInTheDocument()
  })

  it('shows transport badges', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('stdio')).toBeInTheDocument()
    })
    expect(screen.getByText('sse')).toBeInTheDocument()
  })

  it('shows platform badge for platform servers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('platform')).toBeInTheDocument()
    })
  })

  it('shows agent count', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('2 agents')).toBeInTheDocument()
    })
    expect(screen.getByText('0 agents')).toBeInTheDocument()
  })

  it('shows empty state when no servers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
  })

  it('shows create form when Add Server clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    // Click the first Add Server button
    fireEvent.click(screen.getAllByText('Add Server')[0])
    expect(screen.getByText('New MCP Server')).toBeInTheDocument()
    expect(screen.getByText('Transport')).toBeInTheDocument()
  })

  it('shows command field for stdio transport', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByText('Add Server')[0])
    expect(screen.getByText('Command')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/npx -y/)).toBeInTheDocument()
  })

  it('shows URL field for SSE transport', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByText('Add Server')[0])
    // Switch to SSE
    fireEvent.change(screen.getByDisplayValue('stdio (local process)'), { target: { value: 'sse' } })
    expect(screen.getByText('Server URL')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/localhost:3001/)).toBeInTheDocument()
  })

  it('shows description when present', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('GitHub API tools')).toBeInTheDocument()
    })
  })

  it('handles non-array API response gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'not found' }) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
  })
})
