import { createHash } from 'node:crypto';
import type { PmStreamEvent } from './stream-client';

export type PmDeliveryBatch = {
  conversationKey: string;
  event: PmStreamEvent;
};

/** Split a stream frame so every EigenFlux conversation has its own ordering key. */
export function splitPmEventByConversation(event: PmStreamEvent): PmDeliveryBatch[] {
  const data = event.data ?? {};
  const messagesByConversation = new Map<string, NonNullable<typeof data.messages>>();

  for (const message of data.messages ?? []) {
    const key = message.conv_id?.trim() || `sender:${message.sender_id ?? 'unknown'}`;
    const messages = messagesByConversation.get(key) ?? [];
    messages.push(message);
    messagesByConversation.set(key, messages);
  }

  const batches: PmDeliveryBatch[] = Array.from(messagesByConversation, ([conversationKey, messages]) => ({
    conversationKey,
    event: {
      ...event,
      data: {
        ...data,
        messages,
        friend_requests: [],
        friend_responses: [],
      },
    },
  }));

  const hasRelationEvent =
    (data.friend_requests?.length ?? 0) > 0 ||
    (data.friend_responses?.length ?? 0) > 0 ||
    event.type === 'friend_accepted';
  if (hasRelationEvent) {
    batches.push({
      conversationKey: 'relations',
      event: {
        ...event,
        data: { ...data, messages: [] },
      },
    });
  }

  return batches;
}

export function buildPmSessionKey(serverName: string, conversationKey: string): string {
  return `eigenflux:pm:${stableKey(serverName)}:${stableKey(conversationKey)}`;
}

export function buildPmLane(serverName: string, conversationKey: string): string {
  return `eigenflux-pm:${stableKey(serverName)}:${stableKey(conversationKey)}`;
}

function stableKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
