import { createHash } from 'node:crypto';
import type { PmStreamEvent } from './stream-client';

export type PmDeliveryBatch = {
  conversationKey: string;
  peerKey: string;
  event: PmStreamEvent;
};

/** Split a stream frame so every EigenFlux conversation has its own ordering key. */
export function splitPmEventByConversation(event: PmStreamEvent): PmDeliveryBatch[] {
  const data = event.data ?? {};
  // Reconnect frames can carry a large history_messages backfill together with
  // one new relation/PM event. Stable PM sessions already retain conversation
  // context, and the agent can fetch a bounded history on demand. Never copy
  // this backfill into every delivery batch: it multiplies prompt size and can
  // replay already-handled messages after each Gateway restart.
  const { history_messages: _historyMessages, ...incrementalData } = data;
  const messagesByConversation = new Map<string, NonNullable<typeof data.messages>>();

  for (const message of data.messages ?? []) {
    const key = message.conv_id?.trim() || `sender:${message.sender_id ?? 'unknown'}`;
    const messages = messagesByConversation.get(key) ?? [];
    messages.push(message);
    messagesByConversation.set(key, messages);
  }

  const batches: PmDeliveryBatch[] = Array.from(
    messagesByConversation,
    ([conversationKey, messages]) => ({
      conversationKey,
      peerKey: resolveMessagePeerKey(messages),
      event: {
        ...event,
        data: {
          ...incrementalData,
          messages,
          friend_requests: [],
          friend_responses: [],
        },
      },
    })
  );

  const hasRelationEvent =
    (data.friend_requests?.length ?? 0) > 0 ||
    (data.friend_responses?.length ?? 0) > 0 ||
    event.type === 'friend_accepted';
  if (hasRelationEvent) {
    batches.push({
      conversationKey: 'relations',
      peerKey: 'relations',
      event: {
        ...event,
        data: { ...incrementalData, messages: [] },
      },
    });
  }

  return batches;
}

export function buildPmSessionKey(
  serverName: string,
  peerKey: string,
  conversationKey: string
): string {
  return `eigenflux:pm:${stableKey(serverName)}:${stableKey(peerKey)}:${stableKey(conversationKey)}`;
}

export function buildPmLane(
  serverName: string,
  peerKey: string,
  conversationKey: string
): string {
  return `eigenflux-pm:${stableKey(serverName)}:${stableKey(peerKey)}:${stableKey(conversationKey)}`;
}

function resolveMessagePeerKey(
  messages: NonNullable<PmStreamEvent['data']['messages']>
): string {
  const peerIds = Array.from(
    new Set(
      messages
        .map((message) => message.sender_id?.trim())
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
  return peerIds.length > 0 ? peerIds.join(',') : 'unknown-peer';
}

function stableKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
