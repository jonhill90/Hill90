'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import AgentFormClient from '../../new/AgentFormClient'

export default function AgentEditClient({ agentId, isAdmin = false }: { agentId: string; isAdmin?: boolean }) {
  const router = useRouter()
  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/agents/${agentId}`)
        if (res.ok) {
          setAgent(await res.json())
        } else {
          router.push('/agents')
        }
      } catch {
        router.push('/agents')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [agentId, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!agent) return null

  return (
    <AgentFormClient
      initial={{
        agent_id: agent.agent_id,
        name: agent.name,
        description: agent.description,
        cpus: agent.cpus,
        mem_limit: agent.mem_limit,
        pids_limit: agent.pids_limit,
        soul_md: agent.soul_md,
        rules_md: agent.rules_md,
        models: agent.models,
        skills: agent.skills,
      }}
      agentUuid={agent.id}
      disabled={agent.status === 'running'}
      isAdmin={isAdmin}
    />
  )
}
