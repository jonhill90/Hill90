import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockPush = vi.fn()
const mockBack = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentFormClient from '@/app/agents/new/AgentFormClient'

const MOCK_POLICIES = [
  { id: 'policy-1', name: 'Default Policy', allowed_models: ['gpt-4o-mini'] },
  { id: 'policy-2', name: 'Restricted Policy', allowed_models: ['claude-sonnet'] },
]
const MOCK_USER_MODELS = [{ id: 'um-1', name: 'my-custom-model', is_active: true }]
const MOCK_SKILLS = [
  { id: 'skill-min', name: 'Minimal', description: 'Min', scope: 'container_local', tools_config: {}, instructions_md: '', is_platform: true, tools: [] },
  { id: 'skill-dev', name: 'Developer', description: 'Dev', scope: 'container_local', tools_config: {}, instructions_md: '', is_platform: true, tools: [{ id: 'tool-git', name: 'git' }] },
  { id: 'skill-docker', name: 'Docker', description: 'Docker', scope: 'host_docker', tools_config: {}, instructions_md: '', is_platform: false, tools: [{ id: 'tool-docker', name: 'docker' }] },
]
const MOCK_CONTAINER_PROFILES = [
  {
    id: 'profile-uuid-1', name: 'standard', description: 'Standard runtime',
    docker_image: 'hill90/agentbox:latest', default_cpus: '1.0', default_mem_limit: '1g',
    default_pids_limit: 200, is_platform: true,
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/model-policies') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USER_MODELS) })
    if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
    if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
    if (url === '/api/agents' && opts?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-uuid' }) })
    if (typeof url === 'string' && url.startsWith('/api/agents/') && opts?.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'existing-uuid' }) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentFormClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => cleanup())

  it('renders basic sections and skill selection', async () => {
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('Basic Info')).toBeInTheDocument())
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Models')).toBeInTheDocument()
    expect(screen.getByText('Resources')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByText('Minimal')).toBeInTheDocument()
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.queryByLabelText('Custom')).not.toBeInTheDocument()
  })

  it('non-admin does not see elevated skills', async () => {
    render(<AgentFormClient isAdmin={false} />)
    await waitFor(() => expect(screen.getByText('Minimal')).toBeInTheDocument())
    expect(screen.queryByText('Docker')).not.toBeInTheDocument()
  })

  it('admin sees elevated skills', async () => {
    render(<AgentFormClient isAdmin />)
    await waitFor(() => expect(screen.getByText('Docker')).toBeInTheDocument())
  })

  it('requires at least one skill before submit', async () => {
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('Minimal')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }))
    await waitFor(() => expect(screen.getByText(/please select at least one skill/i)).toBeInTheDocument())
  })

  it('submits selected skill_ids and omits tools_config', async () => {
    render(<AgentFormClient isAdmin />)
    await waitFor(() => expect(screen.getByText('Minimal')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })
    const checkboxes = screen.getAllByRole('checkbox')
    const minCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Minimal'))!
    fireEvent.click(minCheckbox)
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }))
    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find((c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST')
      expect(postCall).toBeTruthy()
      const body = JSON.parse(postCall[1].body)
      expect(body.skill_ids).toEqual(['skill-min'])
      expect(body.tools_config).toBeUndefined()
    })
  })

  // UI-1: Form renders profile selector with standard profile
  it('renders profile selector with standard profile option', async () => {
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('Container Profile')).toBeInTheDocument())
    const select = screen.getByLabelText('Runtime Profile') as HTMLSelectElement
    expect(select).toBeInTheDocument()
    // Verify standard profile option exists
    await waitFor(() => {
      const options = Array.from(select.options).map(o => o.text)
      expect(options).toContain('standard (platform) — hill90/agentbox:latest')
    })
  })

  // M1: Empty user-models → picker shows empty state
  it('shows empty state when no user models available', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
      if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText(/no models available/i)).toBeInTheDocument())
    expect(screen.queryAllByRole('checkbox').filter(cb => cb.closest('label')?.closest('[class*="max-h-48"]'))).toHaveLength(0)
  })

  // M2: One owned active user-model → only that model appears
  it('shows only owned active user models in picker', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'um-1', name: 'my-model', is_active: true }]) })
      if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
      if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('my-model')).toBeInTheDocument())
  })

  // M3: /api/model-policies data is NOT rendered as picker options
  it('does not render model-policies data as picker options', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/model-policies') return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'p1', allowed_models: ['policy-model'] }]) })
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
      if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText(/no models available/i)).toBeInTheDocument())
    expect(screen.queryByText('policy-model')).not.toBeInTheDocument()
  })

  // M4: Edit flow uses same picker source (regression)
  it('edit flow sources models from user-models only', async () => {
    const initial = {
      agent_id: 'existing-agent',
      name: 'Existing Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: [],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'um-1', name: 'edit-model', is_active: true }]) })
      if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
      if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
      if (typeof url === 'string' && url.startsWith('/api/agents/') && opts?.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'existing-uuid' }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    render(<AgentFormClient initial={initial} agentUuid="uuid-1" />)
    await waitFor(() => expect(screen.getByText('edit-model')).toBeInTheDocument())
    // Verify no model-policies fetch was made
    const fetchCalls = mockFetch.mock.calls.map((c: any[]) => c[0])
    expect(fetchCalls).not.toContain('/api/model-policies')
  })

  // M5: Inactive owned model excluded from picker
  it('excludes inactive user models from picker', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/user-models') return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { id: 'um-1', name: 'active-model', is_active: true },
          { id: 'um-2', name: 'inactive-model', is_active: false },
        ])
      })
      if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
      if (url === '/api/container-profiles') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_CONTAINER_PROFILES) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('active-model')).toBeInTheDocument())
    expect(screen.queryByText('inactive-model')).not.toBeInTheDocument()
  })

  // G1: Non-owner sees read-only model section
  it('G1: non-owner sees read-only model section without checkboxes', async () => {
    const initial = {
      agent_id: 'other-agent',
      name: 'Other Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: ['my-custom-model'],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="other-user-id"
        currentUserSub="current-user-id"
      />
    )
    await waitFor(() => expect(screen.getByText('my-custom-model')).toBeInTheDocument())
    // Model should appear as plain text, not as a checkbox in the models section
    const modelsSection = screen.getByText('Assigned Models').closest('fieldset')!
    const modelCheckboxes = modelsSection.querySelectorAll('input[type="checkbox"]')
    expect(modelCheckboxes).toHaveLength(0)
  })

  // G2: Non-owner sees ownership banner
  it('G2: non-owner sees ownership banner', async () => {
    const initial = {
      agent_id: 'other-agent',
      name: 'Other Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: [],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="other-user-id"
        currentUserSub="current-user-id"
      />
    )
    await waitFor(() => expect(screen.getByText(/model assignment is managed by the agent owner/i)).toBeInTheDocument())
  })

  // G3: Non-owner submit omits model_names from PUT body
  it('G3: non-owner submit omits model_names from PUT body', async () => {
    const initial = {
      agent_id: 'other-agent',
      name: 'Other Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: ['my-custom-model'],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="other-user-id"
        currentUserSub="current-user-id"
      />
    )
    await waitFor(() => expect(screen.getByText('my-custom-model')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /update agent/i }))
    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('/api/agents/') && c[1]?.method === 'PUT'
      )
      expect(putCall).toBeTruthy()
      const body = JSON.parse(putCall[1].body)
      expect(body).not.toHaveProperty('model_names')
    })
  })

  // G4: Non-owner submit omits model_policy_id from PUT body
  it('G4: non-owner submit omits model_policy_id from PUT body', async () => {
    const initial = {
      agent_id: 'other-agent',
      name: 'Other Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: [],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="other-user-id"
        currentUserSub="current-user-id"
      />
    )
    await waitFor(() => expect(screen.getByText(/model assignment is managed by the agent owner/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /update agent/i }))
    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('/api/agents/') && c[1]?.method === 'PUT'
      )
      expect(putCall).toBeTruthy()
      const body = JSON.parse(putCall[1].body)
      expect(body).not.toHaveProperty('model_policy_id')
    })
  })

  // G5: Non-owner edits name, model config unchanged
  it('G5: non-owner edits name but model config is not sent', async () => {
    const initial = {
      agent_id: 'other-agent',
      name: 'Other Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: ['existing-model'],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="other-user-id"
        currentUserSub="current-user-id"
      />
    )
    await waitFor(() => expect(screen.getByText('existing-model')).toBeInTheDocument())
    // Non-owner changes the name
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Name' } })
    fireEvent.click(screen.getByRole('button', { name: /update agent/i }))
    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('/api/agents/') && c[1]?.method === 'PUT'
      )
      expect(putCall).toBeTruthy()
      const body = JSON.parse(putCall[1].body)
      expect(body.name).toBe('Updated Name')
      expect(body).not.toHaveProperty('model_names')
      expect(body).not.toHaveProperty('model_policy_id')
    })
  })

  // G6: Owner sees normal editable model section
  it('G6: owner sees normal editable model section with checkboxes', async () => {
    const initial = {
      agent_id: 'my-agent',
      name: 'My Agent',
      description: 'desc',
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: ['my-custom-model'],
      skills: [{ id: 'skill-min', name: 'Minimal', scope: 'container_local' }],
    }
    render(
      <AgentFormClient
        initial={initial}
        agentUuid="uuid-1"
        agentOwner="user-123"
        currentUserSub="user-123"
      />
    )
    await waitFor(() => expect(screen.getByText('Assign Models')).toBeInTheDocument())
    // Owner should see checkboxes in the models section
    const modelsSection = screen.getByText('Assign Models').closest('fieldset')!
    const modelCheckboxes = modelsSection.querySelectorAll('input[type="checkbox"]')
    expect(modelCheckboxes.length).toBeGreaterThan(0)
    // No ownership banner
    expect(screen.queryByText(/model assignment is managed by the agent owner/i)).not.toBeInTheDocument()
  })

  // G7: Owner with no agentOwner prop sees editable (create flow)
  it('G7: no agentOwner prop shows editable model section (create flow)', async () => {
    render(<AgentFormClient />)
    await waitFor(() => expect(screen.getByText('Assign Models')).toBeInTheDocument())
    expect(screen.queryByText(/model assignment is managed by the agent owner/i)).not.toBeInTheDocument()
  })

  it('edit mode pre-selects skills from initial props', async () => {
    const initial = {
      agent_id: 'existing-agent',
      name: 'Existing Agent',
      description: 'desc',
      tools_config: {
        shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
        filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
        health: { enabled: true },
      },
      cpus: '1.0',
      mem_limit: '1g',
      pids_limit: 200,
      soul_md: '',
      rules_md: '',
      models: [],
      skills: [
        { id: 'skill-min', name: 'Minimal', scope: 'container_local' },
        { id: 'skill-dev', name: 'Developer', scope: 'container_local' },
      ],
    }
    render(<AgentFormClient initial={initial} agentUuid="uuid-1" isAdmin />)
    await waitFor(() => expect(screen.getByText('Minimal')).toBeInTheDocument())
    const checkboxes = screen.getAllByRole('checkbox')
    const minCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Minimal')) as HTMLInputElement
    const devCheckbox = checkboxes.find(cb => cb.closest('label')?.textContent?.includes('Developer')) as HTMLInputElement
    expect(minCheckbox.checked).toBe(true)
    expect(devCheckbox.checked).toBe(true)
  })
})

