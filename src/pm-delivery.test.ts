import { buildPmLane, buildPmSessionKey, splitPmEventByConversation } from './pm-delivery';
import type { PmStreamEvent } from './stream-client';

describe('PM delivery routing', () => {
  test('groups messages by conv_id and keeps relation events separate', () => {
    const event: PmStreamEvent = {
      type: 'messages',
      data: {
        messages: [
          { msg_id: '1', conv_id: 'conv-a', sender_id: 'peer-a', content: 'a1', created_at: 1 },
          { msg_id: '2', conv_id: 'conv-b', sender_id: 'peer-b', content: 'b1', created_at: 2 },
          { msg_id: '3', conv_id: 'conv-a', sender_id: 'peer-a', content: 'a2', created_at: 3 },
        ],
        history_messages: [
          { msg_id: 'old-1', conv_id: 'conv-a', sender_id: 'peer-a', content: 'old', created_at: 0 },
        ],
        friend_requests: [
          { request_id: 'r1', from_uid: 'agent-1', created_at: 4 },
        ],
      },
    };

    const batches = splitPmEventByConversation(event);
    expect(batches.map((batch) => batch.conversationKey)).toEqual([
      'conv-a',
      'conv-b',
      'relations',
    ]);
    expect(batches[0].event.data.messages?.map((message) => message.msg_id)).toEqual(['1', '3']);
    expect(batches[0].event.data.friend_requests).toEqual([]);
    expect(batches[2].event.data.messages).toEqual([]);
    expect(batches[2].event.data.friend_requests).toHaveLength(1);
    expect(batches[0].peerKey).toBe('peer-a');
    expect(batches[1].peerKey).toBe('peer-b');
    expect(batches[0].event.data).not.toHaveProperty('history_messages');
    expect(batches[2].event.data).not.toHaveProperty('history_messages');
  });

  test('session and lane keys are stable per peer/conversation and isolate peer collisions', () => {
    expect(buildPmSessionKey('eigenflux', 'peer-a', 'conv-a')).toBe(
      buildPmSessionKey('eigenflux', 'peer-a', 'conv-a')
    );
    expect(buildPmLane('eigenflux', 'peer-a', 'conv-a')).toBe(
      buildPmLane('eigenflux', 'peer-a', 'conv-a')
    );
    expect(buildPmSessionKey('eigenflux', 'peer-a', 'conv-a')).not.toBe(
      buildPmSessionKey('eigenflux', 'peer-a', 'conv-b')
    );
    expect(buildPmSessionKey('eigenflux', 'peer-a', 'conv-a')).not.toBe(
      buildPmSessionKey('eigenflux', 'peer-b', 'conv-a')
    );
  });
});
