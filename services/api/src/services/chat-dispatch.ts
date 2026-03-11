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
}

interface DispatchResult {
  accepted: boolean;
  work_id?: string;
  error?: string;
}

export async function dispatchChatWork(params: ChatDispatchParams): Promise<DispatchResult> {
  const { agentId, workToken, threadId, messageId, messages, model, callbackUrl } = params;

  const url = `http://agentbox-${agentId}:8054/work`;

  console.log(`[chat-dispatch] Dispatching to ${agentId}: thread_id=${threadId} message_id=${messageId} model=${model}`);

  const body = {
    type: 'chat',
    payload: {
      thread_id: threadId,
      message_id: messageId,
      messages,
      model,
      callback_url: callbackUrl,
    },
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
