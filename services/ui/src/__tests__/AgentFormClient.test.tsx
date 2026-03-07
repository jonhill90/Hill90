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
  { id: 'policy-1', name: 'Default Policy', allowed_models: ['gpt-4o-mini'] },
  { id: 'policy-2', name: 'Restricted Policy', allowed_models: ['claude-sonnet'] },
]
const MOCK_USER_MODELS = [
  { id: 'um-1', name: 'my-custom-model' },
]

const MOCK_PRESETS = [
  {
    id: 'preset-min',
    name: 'Minimal',
    description: 'Health monitoring only',
    scope: 'container_local',
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have no shell or filesystem access.',
    is_platform: true,
    tools: [],
  },
  {
    id: 'preset-dev',
    name: 'Developer',
    description: 'Full dev environment',
    scope: 'container_local',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have full developer access with bash, git, make, curl, and jq available.',
    is_platform: true,
    tools: [],
  },
  {
    id: 'preset-docker',
    name: 'Docker Access',
    description: 'Docker socket access',
    scope: 'host_docker',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'docker'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
    instructions_md: 'You have Docker socket access.',
    is_platform: false,
    tools: [{ id: 'tool-docker', name: 'docker' }],
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    }
    if (url === '/api/user-models') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USER_MODELS) })
    }
    if (url === '/api/skills') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESETS) })
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

/** Helper: switch to Custom mode via radio toggle */
async function selectCustomMode() {
  await waitFor(() => {
    expect(screen.getByLabelText('Custom')).toBeInTheDocument()
  })
  fireEvent.click(screen.getByLabelText('Custom'))
}

describe('AgentFormClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders basic info, tools, models, resources, identity sections', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Basic Info')).toBeInTheDocument()
    })

    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getAllByText('Models').length).toBeGreaterThan(0)
    expect(screen.getByText('Resources')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
  })

  it('fetches model sources and renders model checklist', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    })

    expect(screen.getByText('claude-sonnet')).toBeInTheDocument()
    expect(screen.getByText('my-custom-model')).toBeInTheDocument()
    expect(screen.getByText('Assign Models')).toBeInTheDocument()
  })

  it('custom mode hides direct shell/filesystem/health toggles', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    expect(screen.getByText(/does not expose direct tool policy toggles/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Filesystem access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Health endpoint')).not.toBeInTheDocument()
  })

  it('switching modes still works with custom informational view', async () => {
    render(<AgentFormClient />)
    await waitFor(() => {
      expect(screen.getByLabelText('Skills')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Custom'))
    expect(screen.getByText(/runtime access is governed by assigned skills and rbac scope/i)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Skills'))
    await waitFor(() => {
      expect(screen.getAllByText(/Minimal/).length).toBeGreaterThan(0)
    })
  })

  it('submit body includes model_names', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    fireEvent.click(screen.getByLabelText('gpt-4o-mini'))
    fireEvent.click(screen.getByLabelText('my-custom-model'))

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
    expect(body.model_names).toEqual(['gpt-4o-mini', 'my-custom-model'])
  })

  it('custom mode submit still includes tools_config', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

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
    expect(body.tools_config).toBeDefined()
    expect(body.tools_config.shell).toBeDefined()
  })

  it('edit mode without skills starts in Custom informational mode', async () => {
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
      models: ['gpt-4o-mini'],
    }

    render(<AgentFormClient initial={initial} agentUuid="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByText('Tools')).toBeInTheDocument()
    })

    expect(screen.getByText(/does not expose direct tool policy toggles/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()

    const modelCheckbox = screen.getByLabelText('gpt-4o-mini') as HTMLInputElement
    expect(modelCheckbox.checked).toBe(true)
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

  // U1: Form renders radio toggle and checkboxes (not dropdown) for skills
  it('renders radio toggle for Custom/Skills mode', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByLabelText('Skills')).toBeInTheDocument()
    })

    expect(screen.getByLabelText('Custom')).toBeInTheDocument()
    // No dropdown (combobox) for skills
    expect(screen.queryByRole('combobox', { name: /skill/i })).not.toBeInTheDocument()
  })

  // U2: Form Custom/Skills toggle switches mode
  it('Custom/Skills toggle switches mode', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByLabelText('Skills')).toBeInTheDocument()
    })

    // Default: Skills mode -- skill checkboxes visible
    await waitFor(() => {
      expect(screen.getAllByText(/Minimal/).length).toBeGreaterThan(0)
    })

    // Switch to Custom -- informational panel visible
    fireEvent.click(screen.getByLabelText('Custom'))

    await waitFor(() => {
      expect(screen.getByText(/does not expose direct tool policy toggles/i)).toBeInTheDocument()
    })
  })

  // U3: Form Custom mode: manual tools editors shown, skill_ids: [] submitted
  it('Custom mode submits skill_ids: [] with tools_config', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

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
    expect(body.skill_ids).toEqual([])
    expect(body.tools_config).toBeDefined()
  })

  // U4 (old): Form Skills mode: checkboxes shown, skill_ids submitted
  it('Skills mode submits checked skill_ids', async () => {
    render(<AgentFormClient isAdmin />)

    await waitFor(() => {
      expect(screen.getByText(/Minimal/)).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Check two skills using role query to match partial label text
    const checkboxes = screen.getAllByRole('checkbox')
    const minCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Minimal'))!
    const devCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Developer'))!
    fireEvent.click(minCheckbox)
    fireEvent.click(devCheckbox)

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
    expect(body.skill_ids).toHaveLength(2)
    expect(body.skill_ids).toContain('preset-min')
    expect(body.skill_ids).toContain('preset-dev')
  })

  // U5: Form non-admin: elevated skills not shown in checkboxes
  it('non-admin checkboxes exclude elevated skills', async () => {
    render(<AgentFormClient isAdmin={false} />)

    await waitFor(() => {
      expect(screen.getByText(/Minimal/)).toBeInTheDocument()
    })

    // Non-admin should see Minimal and Developer (container_local) but NOT Docker Access (host_docker)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.some(cb => cb.closest('label')?.textContent?.includes('Minimal'))).toBe(true)
    expect(checkboxes.some(cb => cb.closest('label')?.textContent?.includes('Developer'))).toBe(true)
    expect(checkboxes.some(cb => cb.closest('label')?.textContent?.includes('Docker Access'))).toBe(false)
  })

  // U6: Switching between modes has no overwrite confirmation
  it('switching from Custom to Skills does not require confirmation', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    // Switch back to Skills mode
    fireEvent.click(screen.getByLabelText('Skills'))

    await waitFor(() => {
      expect(screen.getAllByText(/Minimal/).length).toBeGreaterThan(0)
    })
  })

  // Skills mode validation: requires at least one skill selected
  it('submit blocked when no skills selected in Skills mode', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByLabelText('Skills')).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Submit without selecting any skill
    const form = screen.getByRole('button', { name: /create agent/i }).closest('form')!
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getByText(/please select at least one skill/i)).toBeInTheDocument()
    })

    const postCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST'
    )
    expect(postCalls).toHaveLength(0)
  })

  // Edit form pre-selects skills and starts in Skills mode
  it('pre-selects skills when initial has skills array', async () => {
    const initial = {
      agent_id: 'existing',
      name: 'Existing Agent',
      description: 'Test',
      tools_config: {
        shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
        filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
        health: { enabled: true },
      },
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: [],
      skills: [
        { id: 'preset-dev', name: 'Developer', scope: 'container_local' },
        { id: 'preset-min', name: 'Minimal', scope: 'container_local' },
      ],
    }

    render(<AgentFormClient initial={initial} agentUuid="uuid-1" />)

    await waitFor(() => {
      expect(screen.getByText(/Minimal/)).toBeInTheDocument()
    })

    // Both skills should be checked
    const checkboxes = screen.getAllByRole('checkbox')
    const minCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Minimal'))! as HTMLInputElement
    expect(minCheckbox.checked).toBe(true)

    const devCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Developer'))! as HTMLInputElement
    expect(devCheckbox.checked).toBe(true)
  })

  // Scope badges shown on skill checkboxes
  it('skill checkboxes show scope badges', async () => {
    render(<AgentFormClient isAdmin />)

    await waitFor(() => {
      expect(screen.getByText(/Minimal/)).toBeInTheDocument()
    })

    // Should show scope labels in checkbox list (multiple skills may have Container scope)
    expect(screen.getAllByText('Container').length).toBeGreaterThan(0)
  })

  // U4 (original): Form Skills mode shows no separate profiles/skills groups
  it('Skills mode shows no separate profiles and skills group headings', async () => {
    render(<AgentFormClient isAdmin />)

    await waitFor(() => {
      expect(screen.getByText(/Minimal/)).toBeInTheDocument()
    })

    // Should NOT have separate group headings
    expect(screen.queryByText('Profiles (sandbox presets)')).not.toBeInTheDocument()
  })
})
