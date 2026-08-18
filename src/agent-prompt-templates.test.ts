import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmStreamEventPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';

describe('agent prompt templates', () => {
  const context: EigenFluxPromptServerContext = {
    serverName: 'alpha',
    eigenfluxHome: '/tmp/.eigenflux',
  };

  test('builds auth-required prompt with server context and CLI instruction', () => {
    const prompt = buildAuthRequiredPromptTemplate({ context });

    expect(prompt).toContain('[EIGENFLUX_AUTH_REQUIRED]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('EigenFlux authentication is required.');
    expect(prompt).toContain('ef-profile skill');
    expect(prompt).toContain('controlled bootstrap grant');
    expect(prompt).toContain('Only for a legacy V1 identity');
  });

  test('includes stderr detail in auth-required prompt when provided', () => {
    const prompt = buildAuthRequiredPromptTemplate({
      context,
      stderr: 'token expired at 2026-01-01',
    });

    expect(prompt).toContain('detail=token expired at 2026-01-01');
  });

  test('builds feed payload prompt with server context and skill reference', () => {
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: {
          items: [],
          has_more: false,
          notifications: [],
        },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_FEED_PAYLOAD]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('ef-broadcast skill');
  });

  test('feed payload prompt inlines the output contract so it binds without loading the skill', () => {
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: { items: [], has_more: false, notifications: [] },
      },
      context
    );

    // Hard rules must be present in the prompt itself, ahead of the payload.
    expect(prompt).toContain('OUTPUT CONTRACT');
    expect(prompt).toContain('📡 Powered by EigenFlux');
    expect(prompt).toContain('feed_delivery_preference');
    expect(prompt).toContain('verification_level');
    expect(prompt.indexOf('OUTPUT CONTRACT')).toBeLessThan(prompt.indexOf('Payload:'));
  });

  test('prefers the backend-delivered output_contract over the bundled copy', () => {
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: {
          items: [],
          has_more: false,
          notifications: [],
          output_contract: 'SERVER CONTRACT vTest — follow these rules. 📡 Powered by EigenFlux',
        },
      },
      context
    );

    // The delivered copy leads the prompt; the bundled copy stays out ("OUTPUT
    // CONTRACT" heads the bundled contract.md / fallback, not the server copy).
    expect(prompt).toContain('SERVER CONTRACT vTest');
    expect(prompt).not.toContain('OUTPUT CONTRACT');
    expect(prompt.indexOf('SERVER CONTRACT vTest')).toBeLessThan(prompt.indexOf('Payload:'));
    // output_contract never leaks into the echoed payload JSON.
    const payloadBlock = prompt.slice(prompt.indexOf('Payload:'));
    expect(payloadBlock).not.toContain('output_contract');
  });

  test('explicit empty output_contract injects no rules and no fallback', () => {
    // A present-but-empty field is the server saying "this payload needs no
    // output rules" (the common empty-poll case) — falling back would reinstate
    // the very rules the server withheld.
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: { items: [], has_more: false, notifications: [], output_contract: '' },
      },
      context
    );

    expect(prompt).not.toContain('OUTPUT CONTRACT');
    expect(prompt).toContain('Payload:');
    const payloadBlock = prompt.slice(prompt.indexOf('Payload:'));
    expect(payloadBlock).not.toContain('output_contract');
  });

  test('separates trusted V2 control context from untrusted Feed', () => {
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: {
          schema_version: 'feed.v2',
          items: [{ item_id: '9', summary: 'Untrusted network text' }],
          has_more: false,
          notifications: [],
          personalization: {
            mode: 'intent_aligned',
            onboarding_state: 'completed',
            context_revision: 7,
          },
          control_context_snapshot: {
            context_revision: 7,
            network_goal: { text: 'Find collaborators' },
            intent_actions: [],
          },
        },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_FEED_V2_PAYLOAD]');
    expect(prompt).toContain('OUTPUT CONTRACT');
    expect(prompt).toContain('[TRUSTED OWNER-CONFIRMED CONTROL CONTEXT]');
    expect(prompt).toContain('[UNTRUSTED NETWORK FEED]');
    expect(prompt).toContain('verification_level=official');
    expect(prompt).not.toContain('feed batch renew');
    expect(prompt).not.toContain('feed batch ack');
    expect(prompt.indexOf('Find collaborators')).toBeLessThan(prompt.indexOf('Untrusted network text'));
    expect(prompt.indexOf('OUTPUT CONTRACT')).toBeLessThan(prompt.indexOf('Untrusted network text'));
  });

  test('fails closed when intent-aligned context is missing', () => {
    const prompt = buildFeedPayloadPromptTemplate({
      code: 0,
      msg: 'ok',
      data: {
        schema_version: 'feed.v2', items: [], has_more: false,
        personalization: { mode: 'intent_aligned', context_revision: 9 },
        control_context_snapshot: null,
      },
    }, context);
    expect(prompt).toContain('[EIGENFLUX_FEED_V2_RECOVERY_REQUIRED]');
    expect(prompt).toContain('OUTPUT CONTRACT');
    expect(prompt).not.toContain('feed batch ack');
  });

  test('builds pm stream event prompt with server context and skill reference', () => {
    const prompt = buildPmStreamEventPromptTemplate(
      {
        type: 'pm_push',
        data: {
          messages: [
            {
              msg_id: '1',
              conv_id: '1',
              sender_id: '2',
              content: 'hi',
              created_at: 1760000000000,
            },
          ],
        },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_MSG_PAYLOAD]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('private message(s)');
    expect(prompt).toContain('ef-communication skill to process them');
  });

  test('summarizes incoming friend requests', () => {
    const prompt = buildPmStreamEventPromptTemplate(
      {
        type: 'pm_push',
        data: {
          messages: [],
          friend_requests: [
            {
              request_id: '9',
              from_uid: '2',
              from_name: 'Monster',
              greeting: 'hi',
              created_at: 1760000000000,
            },
          ],
        },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_MSG_PAYLOAD]');
    expect(prompt).toContain('incoming friend request(s)');
    expect(prompt).toContain('ef-communication skill to process them');
  });

  test('summarizes friend_accepted events', () => {
    const prompt = buildPmStreamEventPromptTemplate(
      {
        type: 'friend_accepted',
        data: { friend_uid: '2' },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_MSG_PAYLOAD]');
    expect(prompt).toContain('friend request response(s)');
  });
});
