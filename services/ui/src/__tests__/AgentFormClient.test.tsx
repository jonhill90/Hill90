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
const MOCK_USER_MODELS = [{ id: 'um-1', name: 'my-custom-model' }]
const MOCK_SKILLS = [
  { id: 'skill-min', name: 'Minimal', description: 'Min', scope: 'container_local', tools_config: {}, instructions_md: '', is_platform: true, tools: [] },
  { id: 'skill-dev', name: 'Developer', description: 'Dev', scope: 'container_local', tools_config: {}, instructions_md: '', is_platform: true, tools: [{ id: 'tool-git', name: 'git' }] },
  { id: 'skill-docker', name: 'Docker', description: 'Docker', scope: 'host_docker', tools_config: {}, instructions_md: '', is_platform: false, tools: [{ id: 'tool-docker', name: 'docker' }] },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/model-policies') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
    if (url === '/api/user-models') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USER_MODELS) })
    if (url === '/api/skills') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILLS) })
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

