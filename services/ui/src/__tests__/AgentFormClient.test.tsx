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

// Mock confirm for overwrite protection tests
const mockConfirm = vi.fn(() => true)
vi.stubGlobal('confirm', mockConfirm)

import AgentFormClient from '@/app/agents/new/AgentFormClient'

const MOCK_POLICIES = [
  { id: 'policy-1', name: 'Default Policy' },
  { id: 'policy-2', name: 'Restricted Policy' },
]

const MOCK_PRESETS = [
  {
    id: 'preset-min',
    name: 'Minimal',
    description: 'Health monitoring only',
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have no shell or filesystem access.',
    is_platform: true,
  },
  {
    id: 'preset-dev',
    name: 'Developer',
    description: 'Full dev environment',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    },
    instructions_md: 'You have full developer access with bash, git, make, curl, and jq available.',
    is_platform: true,
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/model-policies') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_POLICIES) })
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

/** Helper: wait for presets to load then select Custom mode */
async function selectCustomMode() {
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: /skill/i })).toBeInTheDocument()
  })
  const profileSelect = screen.getByRole('combobox', { name: /skill/i })
  fireEvent.change(profileSelect, { target: { value: '' } })
}

describe('AgentFormClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfirm.mockReturnValue(true)
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
    await selectCustomMode()

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
    await selectCustomMode()

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
    await selectCustomMode()

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
    await selectCustomMode()

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
    await selectCustomMode()

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
    await selectCustomMode()

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

    // Edit mode with no preset → Custom mode, tool toggles visible
    const shellCheckbox = screen.getByLabelText('Shell access') as HTMLInputElement
    expect(shellCheckbox.checked).toBe(true)

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

  // T18: New agent starts in unselected prompt state
  it('new agent starts with unselected prompt, not Custom', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /skill/i })).toBeInTheDocument()
    })

    // The select should show "Select a profile..." prompt
    const profileSelect = screen.getByRole('combobox', { name: /skill/i }) as HTMLSelectElement
    expect(profileSelect.value).toBe('__unselected__')

    // Prompt message should be visible
    expect(screen.getByText(/choose a skill/i)).toBeInTheDocument()

    // Tool checkboxes should NOT be visible (neither preset summary nor custom toggles)
    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()
  })

  // T18: Preset dropdown renders options
  it('renders preset dropdown with preset options and Custom', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeInTheDocument()
    })

    expect(screen.getByText('Developer')).toBeInTheDocument()

    // "Custom" option should exist in the tool profile selector
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    expect(profileSelect).toBeInTheDocument()
    const customOption = screen.getByRole('option', { name: /custom/i })
    expect(customOption).toBeInTheDocument()
  })

  // T18: Submit blocked when still in unselected state
  it('submit blocked when no profile selected', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /skill/i })).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Submit without selecting a profile
    const form = screen.getByRole('button', { name: /create agent/i }).closest('form')!
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getByText(/please select a skill/i)).toBeInTheDocument()
    })

    // Should NOT have sent a POST request
    const postCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[0] === '/api/agents' && c[1]?.method === 'POST'
    )
    expect(postCalls).toHaveLength(0)
  })

  // T19: Selecting preset shows summary card
  it('selecting preset shows summary card with tool details', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Select the Developer preset
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // Should show summary with enabled tools info (may match in both summary and instructions)
    await waitFor(() => {
      expect(screen.getAllByText(/shell/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/bash/i).length).toBeGreaterThan(0)
    })

    // Manual tool checkboxes (Shell access, Filesystem access) should NOT be visible
    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()
  })

  // T20: Selecting Custom reveals manual config
  it('selecting Custom shows tool toggles', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Select Developer preset first (from unselected)
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // Now switch to Custom
    fireEvent.change(profileSelect, { target: { value: '' } })

    // Manual tool checkboxes should be visible again
    await waitFor(() => {
      expect(screen.getByLabelText('Shell access')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Filesystem access')).toBeInTheDocument()
    expect(screen.getByLabelText('Health endpoint')).toBeInTheDocument()
  })

  // T20 continued: Selecting Custom from unselected also shows toggles
  it('selecting Custom from unselected shows tool toggles', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    expect(screen.getByLabelText('Shell access')).toBeInTheDocument()
    expect(screen.getByLabelText('Filesystem access')).toBeInTheDocument()
    expect(screen.getByLabelText('Health endpoint')).toBeInTheDocument()
  })

  // T21: Preset→Custom populates fields from preset
  it('switching from preset to Custom populates tool fields from preset', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Select Developer preset
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // Switch to Custom
    fireEvent.change(profileSelect, { target: { value: '' } })

    // Shell should be enabled (from Developer preset)
    await waitFor(() => {
      const shellCheckbox = screen.getByLabelText('Shell access') as HTMLInputElement
      expect(shellCheckbox.checked).toBe(true)
    })

    // Filesystem should be enabled (from Developer preset)
    const fsCheckbox = screen.getByLabelText('Filesystem access') as HTMLInputElement
    expect(fsCheckbox.checked).toBe(true)
  })

  // Submit body includes skill_ids when skill selected
  it('submit body includes skill_ids when skill selected', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

    // Select Developer skill
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

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
    expect(body.skill_ids).toEqual(['preset-dev'])
  })

  // Submit body sends skill_ids empty when Custom selected
  it('submit body sends skill_ids empty when Custom selected', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Agent ID (slug)'), { target: { value: 'test-agent' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Agent' } })

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
    expect(body.skill_ids).toEqual([])
  })

  // Edit form pre-selects skill when initial has skills array
  it('pre-selects skill when initial has skills array', async () => {
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
      model_policy_id: null,
      skills: [{ id: 'preset-dev', name: 'Developer', scope: 'container_local' }],
    }

    render(<AgentFormClient initial={initial} agentUuid="uuid-1" />)

    await waitFor(() => {
      const profileSelect = screen.getByRole('combobox', { name: /skill/i }) as HTMLSelectElement
      expect(profileSelect.value).toBe('preset-dev')
    })
  })

  // Overwrite protection: dirty custom → preset selection prompts confirmation
  it('dirty custom state prompts confirmation before switching to preset', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    // Make a manual change in Custom mode (enable shell = dirty)
    fireEvent.click(screen.getByLabelText('Shell access'))

    // Now try to switch to Developer preset
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // confirm() should have been called
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringContaining('overwrite')
    )
  })

  // Overwrite protection: cancel keeps custom state intact
  it('cancel on overwrite confirmation keeps custom state', async () => {
    mockConfirm.mockReturnValue(false)

    render(<AgentFormClient />)
    await selectCustomMode()

    // Make a manual change (enable shell)
    fireEvent.click(screen.getByLabelText('Shell access'))

    // Try to switch to preset — user cancels
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // Should still be in Custom mode
    expect((profileSelect as HTMLSelectElement).value).toBe('')

    // Shell should still be checked (custom state preserved)
    const shellCheckbox = screen.getByLabelText('Shell access') as HTMLInputElement
    expect(shellCheckbox.checked).toBe(true)
  })

  // Overwrite protection: confirm applies the preset
  it('confirm on overwrite applies preset config', async () => {
    mockConfirm.mockReturnValue(true)

    render(<AgentFormClient />)
    await selectCustomMode()

    // Make a manual change (enable shell only, filesystem stays disabled)
    fireEvent.click(screen.getByLabelText('Shell access'))

    // Switch to Developer preset — user confirms
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // Should now be in preset mode
    expect((profileSelect as HTMLSelectElement).value).toBe('preset-dev')

    // Manual tool checkboxes should NOT be visible (preset summary shown instead)
    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()

    // Preset summary should show Developer description
    expect(screen.getByText('Full dev environment')).toBeInTheDocument()
  })

  // No confirmation when switching from clean Custom (no changes) to preset
  it('no confirmation when switching from unmodified Custom to preset', async () => {
    render(<AgentFormClient />)
    await selectCustomMode()

    // Don't make any changes — just switch to preset
    const profileSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(profileSelect, { target: { value: 'preset-dev' } })

    // confirm() should NOT have been called
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  // T12: Agent form dropdown says "Skill"
  it('agent form shows Skill dropdown label', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /^skill$/i })).toBeInTheDocument()
    })
  })

  // T13: Agent form shows instructions preview when skill selected
  it('selecting skill shows instructions preview', async () => {
    render(<AgentFormClient />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Select Developer skill
    const skillSelect = screen.getByRole('combobox', { name: /skill/i })
    fireEvent.change(skillSelect, { target: { value: 'preset-dev' } })

    // Should show instructions preview
    await waitFor(() => {
      expect(screen.getByText(/full developer access with bash/i)).toBeInTheDocument()
    })
  })
})
