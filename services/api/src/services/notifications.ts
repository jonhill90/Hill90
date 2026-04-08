import { getPool } from '../db/pool';

export type NotificationType = 'agent_start' | 'agent_stop' | 'agent_error' | 'info';

/**
 * Create a notification for a user. Fire-and-forget — never throws.
 */
export function notify(
  userId: string,
  message: string,
  type: NotificationType = 'info',
  metadata?: Record<string, unknown>
): void {
  void insertNotification(userId, message, type, metadata);
}

async function insertNotification(
  userId: string,
  message: string,
  type: NotificationType,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO notifications (user_id, message, type, metadata) VALUES ($1, $2, $3, $4)`,
      [userId, message, type, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error(`[notifications] Failed to insert for ${userId}:`, err);
  }
}
