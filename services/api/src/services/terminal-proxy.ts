/**
 * WebSocket terminal proxy — relays between browser and agentbox PTY.
 *
 * Path: /chat/threads/:threadId/terminal?token=<session-token>
 *
 * Auth: Validates Keycloak JWT from query param, checks thread
 * participation, then opens a WebSocket to agentbox and relays.
 */

import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { getPool } from '../db/pool';

const CONTAINER_PREFIX = 'agentbox-';
const AGENTBOX_PORT = 8054;
const PING_INTERVAL_MS = 30_000; // 30s keep-alive ping

/**
 * Extract threadId from upgrade path: /chat/threads/:id/terminal
 */
function parseThreadId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/chat\/threads\/([^/]+)\/terminal/);
  return match ? match[1] : null;
}

/**
 * Resolve the agentbox WebSocket URL for a thread's running agent.
 */
async function resolveAgentWsUrl(threadId: string, workToken: string): Promise<string | null> {
  const pool = getPool();

  // Find running agent participant for this thread
  const { rows } = await pool.query(
    `SELECT a.agent_id, a.work_token
     FROM chat_participants cp
     JOIN agents a ON a.id::text = cp.participant_id
     WHERE cp.thread_id = $1
       AND cp.participant_type = 'agent'
       AND a.status = 'running'
     LIMIT 1`,
    [threadId]
  );

  if (rows.length === 0) return null;

  const agentSlug = rows[0].agent_id;
  const agentWorkToken = rows[0].work_token;

  return `ws://${CONTAINER_PREFIX}${agentSlug}:${AGENTBOX_PORT}/terminal/ws?token=${agentWorkToken}`;
}

/**
 * Check if user is a participant in the thread.
 */
async function isParticipant(threadId: string, userSub: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'human'
     LIMIT 1`,
    [threadId, userSub]
  );
  return rows.length > 0;
}

/**
 * Attach WebSocket terminal proxy to an HTTP server.
 *
 * Handles upgrade requests matching /chat/threads/:id/terminal.
 * Auth via Keycloak JWT in Authorization header or token query param.
 */
export function attachTerminalProxy(
  server: ReturnType<typeof import('http').createServer>,
  verifyToken: (token: string) => Promise<{ sub: string; roles?: string[] } | null>,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    console.log(`[terminal-proxy] Upgrade request: ${req.url} from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);

    const threadId = parseThreadId(req.url);
    if (!threadId) {
      console.log('[terminal-proxy] No threadId in path, ignoring upgrade');
      // Not our path — let other handlers deal with it
      return;
    }

    try {
      // Extract token from query param or Authorization header
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token')
        || (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null);

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Verify Keycloak JWT
      const user = await verifyToken(token);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check thread participation (admin bypass)
      const isAdmin = user.roles?.includes('admin');
      if (!isAdmin && !(await isParticipant(threadId, user.sub))) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Resolve agentbox WebSocket URL
      const agentWsUrl = await resolveAgentWsUrl(threadId, '');
      console.log(`[terminal-proxy] Resolved agentbox URL for thread=${threadId}: ${agentWsUrl ? 'found' : 'not found'}`);
      if (!agentWsUrl) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete the upgrade
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        // Connect to agentbox
        const agentWs = new WebSocket(agentWsUrl);

        agentWs.on('open', () => {
          console.log(`[terminal-proxy] Connected to agentbox for thread=${threadId} url=${agentWsUrl}`);
        });

        agentWs.on('unexpected-response', (_req: any, res: any) => {
          console.error(`[terminal-proxy] Agentbox unexpected response: ${res.statusCode} for thread=${threadId}`);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
        });

        // Keep-alive: ping both sides every 30s to prevent idle timeout
        // from Traefik, load balancers, or browser network stack
        const pingInterval = setInterval(() => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping();
          }
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.ping();
          }
        }, PING_INTERVAL_MS);

        function cleanupAll() {
          clearInterval(pingInterval);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
          if (agentWs.readyState === WebSocket.OPEN) agentWs.close();
        }

        // Relay: agentbox → client
        agentWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });

        // Relay: client → agentbox
        clientWs.on('message', (data, isBinary) => {
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.send(data, { binary: isBinary });
          }
        });

        // Cleanup on either side close
        agentWs.on('close', cleanupAll);
        clientWs.on('close', cleanupAll);

        agentWs.on('error', (err) => {
          console.error(`[terminal-proxy] Agentbox WS error: ${err.message}`);
          cleanupAll();
        });
        clientWs.on('error', (err) => {
          console.error(`[terminal-proxy] Client WS error: ${err.message}`);
          cleanupAll();
        });
      });

    } catch (err) {
      console.error('[terminal-proxy] Upgrade error:', err);
      socket.destroy();
    }
  });
}
