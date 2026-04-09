/**
 * Chat dispatch — POST work to agentbox container.
 *
 * API sends structured data only: messages array, model, callback info.
 * Agentbox is sole owner of system prompt assembly (§7.5 boundary).
 */

interface ChatDispatchParams {
  agentId: string;       // agent slug (for container hostname)
  workToken: string;     // Bearer token for agentbox auth
  threadId: string;      // Thread UUID
  messageId: string;     // Assistant placeholder UUID (callback key + correlation_id)
  messages: Array<{ role: string; content: string }>;
  model: string;
  callbackUrl: string;
  threadType?: string;   // 'direct' | 'group' — omitted for backward compat
  participants?: Array<{ agent_id: string; name: string }>;  // group thread participant list
  isLead?: boolean;      // true when this agent is the lead in collaborative mode
  collaborators?: Array<{ agent_id: string; name: string }>;  // other agents the lead can query
}

interface DispatchResult {
  accepted: boolean;
  work_id?: string;
  error?: string;
}

export async function dispatchChatWork(params: ChatDispatchParams): Promise<DispatchResult> {
  const { agentId, workToken, threadId, messageId, messages, model, callbackUrl, threadType, participants, isLead, collaborators } = params;

  const url = `http://agentbox-${agentId}:8054/work`;

  console.log(`[chat-dispatch] Dispatching to ${agentId}: thread_id=${threadId} message_id=${messageId} model=${model} lead=${!!isLead}`);

  const payload: Record<string, unknown> = {
    thread_id: threadId,
    message_id: messageId,
    messages,
    model,
    callback_url: callbackUrl,
  };
  if (threadType) payload.thread_type = threadType;
  if (participants && participants.length > 0) payload.participants = participants;
  if (isLead) payload.is_lead = true;
  if (collaborators && collaborators.length > 0) payload.collaborators = collaborators;

  const body = {
    type: 'chat',
    payload,
    correlation_id: messageId, // §8.5: correlation_id = message_id
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${workToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    console.error(`[chat-dispatch] Failed for ${agentId}: ${response.status} ${text}`);
    return { accepted: false, error: `Agentbox returned ${response.status}: ${text}` };
  }

  const result = await response.json() as { accepted: boolean; work_id?: string };
  console.log(`[chat-dispatch] Accepted by ${agentId}: work_id=${result.work_id}`);
  return { accepted: result.accepted, work_id: result.work_id };
}
