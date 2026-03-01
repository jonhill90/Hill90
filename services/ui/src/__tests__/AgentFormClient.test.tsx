import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/navigation
const mockPush = vi.fn()
const mockBack = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentFormClient from '@/app/agents/new/AgentFormClient'

const MOCK_POLICIES = [
  { id: 'policy-1', name: 'Default Policy' },
  { id: 'policy-2', name: 'Restricted Policy' },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    }
    if (url === '/api/agents' && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-uuid' }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/agents/') && opts?.method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'existing-uuid' }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentFormClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders basic info, tools, model policy, resources, identity sections', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Basic Info')).toBeInTheDocument()
    })

    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getAllByText('Model Policy').length).toBeGreaterThan(0)
    expect(screen.getByText('Resources')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
  })

  it('fetches policies and renders selector with None option', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    expect(screen.getByText('Restricted Policy')).toBeInTheDocument()
    // "None" option should exist
    const selectEl = screen.getByRole('combobox', { name: /model policy/i })
    expect(selectEl).toBeInTheDocument()
    const noneOption = screen.getByRole('option', { name: 'None' })
    expect(noneOption).toBeInTheDocument()
  })

  it('shows shell advanced fields when shell enabled', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Enable shell
    const shellCheckbox = screen.getByLabelText('Shell access')
    fireEvent.click(shellCheckbox)

    // Click "Advanced settings" to expand
    const advancedLink = screen.getByText('Advanced settings', { selector: 'button' })
    fireEvent.click(advancedLink)

    expect(screen.getByText('Allowed Binaries')).toBeInTheDocument()
    expect(screen.getByText('Denied Patterns')).toBeInTheDocument()
    expect(screen.getByLabelText('Max Timeout (seconds)')).toBeInTheDocument()
  })

  it('shows filesystem advanced fields when filesystem enabled', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Enable filesystem
    const fsCheckbox = screen.getByLabelText('Filesystem access')
    fireEvent.click(fsCheckbox)

    // Click "Advanced settings" for filesystem
    const advancedLinks = screen.getAllByText('Advanced settings', { selector: 'button' })
    fireEvent.click(advancedLinks[0])

    expect(screen.getByText('Allowed Paths')).toBeInTheDocument()
    expect(screen.getByText('Denied Paths')).toBeInTheDocument()
  })

  it('submit body includes model_policy_id', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Default Policy')).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Select a policy
    const policySelect = screen.getByRole('combobox', { name: /model policy/i })
    fireEvent.change(policySelect, { target: { value: 'policy-1' } })

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
        method: 'POST',
      }))
    })

    const postCall = mockFetch.mock.calls.find(
      (c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST'
    )!
    const body = JSON.parse(postCall[1].body)
    expect(body.model_policy_id).toBe('policy-1')
  })

  it('submit body includes advanced tools_config fields', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Enable shell
    fireEvent.click(screen.getByLabelText('Shell access'))

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
        method: 'POST',
      }))
    })

    const postCall = mockFetch.mock.calls.find(
      (c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST'
    )!
    const body = JSON.parse(postCall[1].body)
    expect(body.tools_config.shell.enabled).toBe(true)
    expect(body.tools_config.shell.allowed_binaries).toEqual([])
    expect(body.tools_config.shell.denied_patterns).toEqual([])
    expect(body.tools_config.shell.max_timeout).toBe(300)
  })

  it('rejects max_timeout less than 1', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Enable shell and open advanced
    fireEvent.click(screen.getByLabelText('Shell access'))
    fireEvent.click(screen.getByText('Advanced settings', { selector: 'button' }))

    // Set invalid timeout
    const timeoutInput = screen.getByLabelText('Max Timeout (seconds)')
    fireEvent.change(timeoutInput, { target: { value: '0' } })

    // Submit via form submit event to bypass native validation
    const form = screen.getByRole('button', { name: /create agent/i }).closest('form')!
    fireEvent.submit(form)

    // Should show validation error, not send request
    await waitFor(() => {
      expect(screen.getByText(/timeout must be at least 1/i)).toBeInTheDocument()
    })

    const postCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST'
    )
    expect(postCalls).toHaveLength(0)
  })

  it('rejects path not starting with /', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Enable filesystem and open advanced
    fireEvent.click(screen.getByLabelText('Filesystem access'))
    const advancedLinks = screen.getAllByText('Advanced settings', { selector: 'button' })
    fireEvent.click(advancedLinks[0])

    // Try to add invalid path via TagInput
    const pathInputs = screen.getAllByPlaceholderText(/add/i)
    // The first TagInput under filesystem advanced should be allowed_paths
    fireEvent.change(pathInputs[0], { target: { value: 'nope' } })
    fireEvent.keyDown(pathInputs[0], { key: 'Enter' })

    expect(screen.getByText(/must start with \//i)).toBeInTheDocument()
  })

  it('pre-fills advanced tools_config from initial prop', async () => {
    const initial = {
      agent_id: 'existing',
      name: 'Existing Agent',
      description: 'Test',
      tools_config: {
        shell: { enabled: true, allowed_binaries: ['bash', 'node'], denied_patterns: ['rm -rf'], max_timeout: 600 },
        filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/tmp'], denied_paths: ['/etc/shadow'] },
        health: { enabled: true },
      },
      cpus: '2.0',
      mem_limit: '2g',
      pids_limit: 300,
      soul_md: 'soul text',
      rules_md: 'rules text',
      model_policy_id: 'policy-1',
    }

    render(<AgentFormClient initial={initial} agentUuid="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    // Shell should be checked
    const shellCheckbox = screen.getByLabelText('Shell access') as HTMLInputElement
    expect(shellCheckbox.checked).toBe(true)

    // Filesystem should be checked
    const fsCheckbox = screen.getByLabelText('Filesystem access') as HTMLInputElement
    expect(fsCheckbox.checked).toBe(true)

    // Policy selector should have policy-1 selected
    await waitFor(() => {
      const policySelect = screen.getByRole('combobox', { name: /model policy/i }) as HTMLSelectElement
      expect(policySelect.value).toBe('policy-1')
    })
  })

  it('disables all inputs when disabled prop is true', async () => {
    const initial = {
      agent_id: 'existing',
      name: 'Existing Agent',
      description: 'Test',
      tools_config: {
        shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
        filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
        health: { enabled: true },
      },
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
    }

    render(<AgentFormClient initial={initial} agentUuid="uuid-1" disabled />)

    await waitFor(() => {
      expect(screen.getByText('This agent is running. Stop it before making changes.')).toBeInTheDocument()
    })

    // Submit button should be disabled
    const submitBtn = screen.getByRole('button', { name: /update agent/i })
    expect(submitBtn).toBeDisabled()
  })

  it('shows character count for identity fields', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Identity')).toBeInTheDocument()
    })

    const soulTextarea = screen.getByLabelText('SOUL.md')
    fireEvent.change(soulTextarea, { target: { value: 'Hello world' } })

    expect(screen.getByText('11 characters')).toBeInTheDocument()
  })
})
