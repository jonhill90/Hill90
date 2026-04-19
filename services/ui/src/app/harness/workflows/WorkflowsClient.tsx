'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Play, Pause, Trash2, Clock, Zap, RefreshCw } from 'lucide-react'

interface Workflow {
  id: string
  name: string
  description: string | null
  agent_id: string
  agent_name: string
  agent_slug: string
  agent_status: string
  schedule_cron: string | null
  prompt: string
  trigger_type: string
  webhook_token: string | null
  output_type: string
  output_config: Record<string, unknown>
  enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
}

interface WorkflowRun {
  id: string
  workflow_id: string
  status: string
  thread_id: string | null
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  result_summary: string | null
  error: string | null
}

interface Agent {
  id: string
  name: string
  agent_id: string
  status: string
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return cron
  const [min, hour, dom, mon, dow] = parts

  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} minutes`
  if (min !== '*' && hour !== '*' && dom === '*' && dow === '*') return `Daily at ${hour}:${min.padStart(2, '0')}`
  if (min !== '*' && hour !== '*' && dow !== '*' && dom === '*') {
    const days: Record<string, string> = { '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '1-5': 'Weekdays' }
    return `${days[dow] || dow} at ${hour}:${min.padStart(2, '0')}`
  }
  if (hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`
  return cron
}

export default function WorkflowsClient() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [steps, setSteps] = useState<Array<{ id: string; agent_id: string; agent_name: string; agent_slug: string; prompt: string; step_order: number }>>([])
  const [stepsLoading, setStepsLoading] = useState(false)
  const [rightTab, setRightTab] = useState<'runs' | 'steps'>('runs')
  const [stepForm, setStepForm] = useState({ agent_id: '', prompt: '' })

  const [form, setForm] = useState({
    name: '', description: '', agent_id: '', schedule_cron: '*/30 * * * *', prompt: '', output_type: 'none', output_config: '{}', trigger_type: 'cron'
  })

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch('/api/workflows')
      if (res.ok) setWorkflows(await res.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (res.ok) setAgents(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchWorkflows(); fetchAgents() }, [fetchWorkflows, fetchAgents])

  const fetchRuns = useCallback(async (workflowId: string) => {
    setRunsLoading(true)
    try {
      const res = await fetch(`/api/workflows/${workflowId}/runs`)
      if (res.ok) setRuns(await res.json())
    } catch { /* ignore */ }
    finally { setRunsLoading(false) }
  }, [])

  const fetchSteps = useCallback(async (workflowId: string) => {
    setStepsLoading(true)
    try {
      const res = await fetch(`/api/workflows/${workflowId}/steps`)
      if (res.ok) setSteps(await res.json())
    } catch { /* ignore */ }
    finally { setStepsLoading(false) }
  }, [])

  useEffect(() => {
    if (selectedId) { fetchRuns(selectedId); fetchSteps(selectedId) }
  }, [selectedId, fetchRuns, fetchSteps])

  const handleSubmit = async () => {
    const body = { ...form, output_config: JSON.parse(form.output_config || '{}'), schedule_cron: form.trigger_type === 'webhook' ? null : form.schedule_cron }
    const url = editingId ? `/api/workflows/${editingId}` : '/api/workflows'
    const method = editingId ? 'PUT' : 'POST'
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      setShowForm(false)
      setEditingId(null)
      setForm({ name: '', description: '', agent_id: '', schedule_cron: '*/30 * * * *', prompt: '', output_type: 'none', output_config: '{}' })
      fetchWorkflows()
    }
  }

  const handleToggle = async (wf: Workflow) => {
    await fetch(`/api/workflows/${wf.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !wf.enabled }),
    })
    fetchWorkflows()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this workflow?')) return
    await fetch(`/api/workflows/${id}`, { method: 'DELETE' })
    if (selectedId === id) { setSelectedId(null); setRuns([]) }
    fetchWorkflows()
  }

  const handleRun = async (wf: Workflow) => {
    setRunning(wf.id)
    try {
      const res = await fetch(`/api/workflows/${wf.id}/run`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to run workflow')
      } else {
        fetchWorkflows()
        if (selectedId === wf.id) fetchRuns(wf.id)
      }
    } catch { alert('Failed to run workflow') }
    finally { setRunning(null) }
  }

  const handleAddStep = async () => {
    if (!selectedId || !stepForm.agent_id || !stepForm.prompt) return
    await fetch(`/api/workflows/${selectedId}/steps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stepForm),
    })
    setStepForm({ agent_id: '', prompt: '' })
    fetchSteps(selectedId)
  }

  const handleDeleteStep = async (stepId: string) => {
    if (!selectedId) return
    await fetch(`/api/workflows/${selectedId}/steps/${stepId}`, { method: 'DELETE' })
    fetchSteps(selectedId)
  }

  const handleEdit = (wf: Workflow) => {
    setForm({
      name: wf.name,
      description: wf.description || '',
      agent_id: wf.agent_id,
      schedule_cron: wf.schedule_cron,
      prompt: wf.prompt,
      output_type: wf.output_type,
      output_config: JSON.stringify(wf.output_config || {}),
    })
    setEditingId(wf.id)
    setShowForm(true)
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Workflows</h1>
          <p className="text-mountain-400 text-sm mt-1">{workflows.length} workflow{workflows.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', description: '', agent_id: '', schedule_cron: '*/30 * * * *', prompt: '', output_type: 'none', output_config: '{}' }) }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer"
        >
          <Plus className="w-4 h-4" /> New Workflow
        </button>
      </div>

      {/* Create/Edit Form */}
      {showForm && (
        <div className="mb-6 rounded-lg border border-navy-700 bg-navy-800 p-5">
          <h3 className="text-lg font-semibold text-white mb-4">{editingId ? 'Edit Workflow' : 'New Workflow'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" placeholder="Daily Health Check" />
            </div>
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Agent</label>
              <select value={form.agent_id} onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none">
                <option value="">Select agent...</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.status})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Trigger</label>
              <select value={form.trigger_type} onChange={e => setForm(f => ({ ...f, trigger_type: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none">
                <option value="cron">Cron Schedule</option>
                <option value="webhook">Webhook URL</option>
              </select>
            </div>
            {form.trigger_type === 'cron' && (
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Schedule (cron)</label>
                <input value={form.schedule_cron} onChange={e => setForm(f => ({ ...f, schedule_cron: e.target.value }))}
                  className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" placeholder="*/30 * * * *" />
                <p className="text-xs text-mountain-500 mt-1">{cronToHuman(form.schedule_cron)}</p>
              </div>
            )}
            {form.trigger_type === 'webhook' && (
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Webhook</label>
                <p className="text-xs text-mountain-400">A unique webhook URL will be generated when you create this workflow. External services can POST to it to trigger the agent.</p>
              </div>
            )}
            <div>
              <label className="block text-sm text-mountain-400 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" placeholder="Optional description" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-mountain-400 mb-1">Prompt</label>
              <textarea value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} rows={3}
                className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" placeholder="Check all service health endpoints and report any issues..." />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button onClick={handleSubmit} disabled={!form.name || !form.agent_id || !form.prompt}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50 cursor-pointer">
              {editingId ? 'Save Changes' : 'Create Workflow'}
            </button>
            <button onClick={() => { setShowForm(false); setEditingId(null) }}
              className="px-4 py-2 rounded-lg text-mountain-400 hover:text-white text-sm cursor-pointer">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Workflow List */}
      {workflows.length === 0 && !showForm ? (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 flex flex-col items-center justify-center text-center">
          <div className="mb-4 rounded-full bg-navy-700 p-4"><Zap className="h-8 w-8 text-mountain-400" /></div>
          <h2 className="text-lg font-semibold text-white mb-2">No workflows yet</h2>
          <p className="text-mountain-400 max-w-md mb-4">Create a workflow to automatically run agents on a schedule.</p>
          <button onClick={() => setShowForm(true)} className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer">
            <Plus className="w-4 h-4 inline mr-1" /> Create Workflow
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: Workflow cards */}
          <div className="space-y-3">
            {workflows.map(wf => (
              <div
                key={wf.id}
                onClick={() => setSelectedId(wf.id)}
                className={`rounded-lg border p-4 cursor-pointer transition-colors ${
                  selectedId === wf.id ? 'border-brand-500 bg-navy-800' : 'border-navy-700 bg-navy-800/50 hover:border-navy-600'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-white">{wf.name}</h3>
                    <span className={`px-1.5 py-0.5 text-xs rounded ${wf.enabled ? 'bg-brand-600/20 text-brand-400' : 'bg-navy-700 text-mountain-500'}`}>
                      {wf.enabled ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={(e) => { e.stopPropagation(); handleRun(wf) }} disabled={running === wf.id}
                      className="p-1.5 rounded text-mountain-400 hover:text-brand-400 hover:bg-navy-700 cursor-pointer" title="Run now">
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleToggle(wf) }}
                      className="p-1.5 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer" title={wf.enabled ? 'Pause' : 'Enable'}>
                      {wf.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleEdit(wf) }}
                      className="p-1.5 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer" title="Edit">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(wf.id) }}
                      className="p-1.5 rounded text-mountain-400 hover:text-red-400 hover:bg-navy-700 cursor-pointer" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-xs text-mountain-400 space-y-1">
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {wf.trigger_type === 'webhook' ? 'Webhook trigger' : wf.schedule_cron ? cronToHuman(wf.schedule_cron) : 'No schedule'}
                  </div>
                  {wf.webhook_token && (
                    <div className="text-xs text-mountain-500 font-mono truncate" title={`/workflows/webhook/${wf.webhook_token}`}>
                      Webhook: /workflows/webhook/{wf.webhook_token.slice(0, 12)}...
                    </div>
                  )}
                  <div>Agent: <span className="text-mountain-300">{wf.agent_name}</span>
                    <span className={`ml-1 text-xs ${wf.agent_status === 'running' ? 'text-brand-400' : 'text-mountain-500'}`}>({wf.agent_status})</span>
                  </div>
                  {wf.last_run_at && <div>Last run: {relativeTime(wf.last_run_at)}</div>}
                </div>
                <p className="text-xs text-mountain-500 mt-2 truncate">{wf.prompt}</p>
              </div>
            ))}
          </div>

          {/* Right: Runs + Steps */}
          <div className="rounded-lg border border-navy-700 bg-navy-800 p-4">
            {selectedId ? (
              <>
                <div className="flex items-center gap-2 mb-3 border-b border-navy-700 pb-2">
                  <button onClick={() => setRightTab('runs')} className={`text-sm font-medium px-2 py-1 rounded cursor-pointer ${rightTab === 'runs' ? 'text-brand-400 bg-brand-600/10' : 'text-mountain-400 hover:text-white'}`}>Runs</button>
                  <button onClick={() => setRightTab('steps')} className={`text-sm font-medium px-2 py-1 rounded cursor-pointer ${rightTab === 'steps' ? 'text-brand-400 bg-brand-600/10' : 'text-mountain-400 hover:text-white'}`}>Steps ({steps.length})</button>
                  <div className="flex-1" />
                  <button onClick={() => rightTab === 'runs' ? fetchRuns(selectedId) : fetchSteps(selectedId)} className="text-xs text-mountain-400 hover:text-white cursor-pointer">Refresh</button>
                </div>

                {rightTab === 'runs' && (
                  runsLoading ? (
                    <div className="flex justify-center py-8"><div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
                  ) : runs.length === 0 ? (
                    <p className="text-sm text-mountain-500 text-center py-8">No runs yet</p>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {runs.map(run => (
                        <div key={run.id} className="rounded border border-navy-600 bg-navy-900 px-3 py-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                              run.status === 'completed' ? 'bg-brand-600/20 text-brand-400' :
                              run.status === 'running' ? 'bg-amber-600/20 text-amber-400' :
                              run.status === 'error' ? 'bg-red-600/20 text-red-400' :
                              'bg-navy-700 text-mountain-400'
                            }`}>{run.status}</span>
                            <span className="text-mountain-500">{relativeTime(run.started_at)}</span>
                          </div>
                          {run.duration_ms != null && <div className="text-mountain-500 mt-1">{(run.duration_ms / 1000).toFixed(1)}s</div>}
                          {run.error && <div className="text-red-400 mt-1 truncate">{run.error}</div>}
                          {run.thread_id && (
                            <a href={`/chat/${run.thread_id}`} className="text-brand-400 hover:underline mt-1 inline-block">View chat →</a>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}

                {rightTab === 'steps' && (
                  <div>
                    {stepsLoading ? (
                      <div className="flex justify-center py-8"><div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
                    ) : (
                      <>
                        {steps.length === 0 ? (
                          <p className="text-sm text-mountain-500 text-center py-4">No steps — this workflow runs a single agent. Add steps to chain multiple agents.</p>
                        ) : (
                          <div className="space-y-2 mb-3">
                            {steps.map((step, i) => (
                              <div key={step.id} className="rounded border border-navy-600 bg-navy-900 px-3 py-2 text-xs flex items-start justify-between">
                                <div>
                                  <div className="text-mountain-300 font-medium">Step {i + 1}: <span className="text-white">{step.agent_name}</span></div>
                                  <div className="text-mountain-500 mt-1 truncate max-w-xs">{step.prompt}</div>
                                </div>
                                <button onClick={() => handleDeleteStep(step.id)} className="p-1 text-mountain-400 hover:text-red-400 cursor-pointer"><Trash2 className="w-3 h-3" /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="border-t border-navy-700 pt-3 mt-3">
                          <p className="text-xs text-mountain-400 mb-2">Add step</p>
                          <select value={stepForm.agent_id} onChange={e => setStepForm(f => ({ ...f, agent_id: e.target.value }))}
                            className="w-full rounded border border-navy-600 bg-navy-900 px-2 py-1.5 text-xs text-white mb-2 focus:border-brand-500 focus:outline-none">
                            <option value="">Select agent...</option>
                            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <textarea value={stepForm.prompt} onChange={e => setStepForm(f => ({ ...f, prompt: e.target.value }))}
                            placeholder="Prompt for this step..."
                            className="w-full rounded border border-navy-600 bg-navy-900 px-2 py-1.5 text-xs text-white mb-2 focus:border-brand-500 focus:outline-none" rows={2} />
                          <button onClick={handleAddStep} disabled={!stepForm.agent_id || !stepForm.prompt}
                            className="px-3 py-1 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 cursor-pointer">Add Step</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Clock className="w-8 h-8 text-mountain-500 mb-2" />
                <p className="text-sm text-mountain-400">Select a workflow to see details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
