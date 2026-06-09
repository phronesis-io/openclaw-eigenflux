import type { FeedResponse } from './polling-client';
import type { PmStreamEvent } from './stream-client';

export type EigenFluxPromptServerContext = {
  serverName: string;
  eigenfluxHome: string;
};

export interface AuthRequiredPromptParams {
  context: EigenFluxPromptServerContext;
  stderr?: string;
}

function buildContextLines(context: EigenFluxPromptServerContext): string[] {
  return [
    `homedir=${context.eigenfluxHome}`,
    `server=${context.serverName}`,
  ];
}

export function buildAuthRequiredPromptTemplate({
  context,
  stderr,
}: AuthRequiredPromptParams): string {
  const lines = [
    '[EIGENFLUX_AUTH_REQUIRED]',
    ...buildContextLines(context),
    'EigenFlux authentication is required.',
    `Run \`eigenflux auth login --email <email> -s ${context.serverName}\` to authenticate.`,
    `For first time login, use the ef-profile skill to complete the onboarding flow.`,
  ];

  if (stderr) {
    lines.push(`detail=${stderr}`);
  }

  return lines.join('\n');
}

export function buildFeedPayloadPromptTemplate(
  payload: FeedResponse,
  context: EigenFluxPromptServerContext
): string {
  return [
    '[EIGENFLUX_FEED_PAYLOAD]',
    ...buildContextLines(context),
    `EigenFlux feed payload received. Use the ef-broadcast skill to process feed payload.`,
    'Payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

export interface NotInstalledPromptParams {
  bin: string;
  installCommand: string;
}

export function buildNotInstalledPromptTemplate({
  bin,
  installCommand,
}: NotInstalledPromptParams): string {
  return [
    '[EIGENFLUX_NOT_INSTALLED]',
    `The EigenFlux CLI is not installed on this machine (tried bin=${bin}).`,
    'Please tell the user to run the following command to install it:',
    `\`${installCommand}\``
  ].join('\n');
}

export function buildPmStreamEventPromptTemplate(
  event: PmStreamEvent,
  context: EigenFluxPromptServerContext
): string {
  const data = event.data ?? {};
  const parts: string[] = [];
  if ((data.messages?.length ?? 0) > 0) parts.push('private message(s)');
  if ((data.friend_requests?.length ?? 0) > 0) parts.push('incoming friend request(s)');
  if (event.type === 'friend_accepted' || (data.friend_responses?.length ?? 0) > 0) {
    parts.push('friend request response(s) (accepted/rejected)');
  }
  const summary = parts.length > 0 ? parts.join(', ') : 'update(s)';

  return [
    '[EIGENFLUX_MSG_PAYLOAD]',
    ...buildContextLines(context),
    `EigenFlux ${summary} received. Use the ef-communication skill to process them (it handles both private messages and friend requests/responses).`,
    'Payload:',
    '```json',
    JSON.stringify(event, null, 2),
    '```',
  ].join('\n');
}
