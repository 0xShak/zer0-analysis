import { Inngest, eventType, staticSchema } from 'inngest';

export const inngest = new Inngest({ id: 'zer0' });

// v4 EventType pattern: declare each event once and reuse as a trigger
// and as a typed payload for inngest.send().
export const chatMessageReceived = eventType('chat/message.received', {
  schema: staticSchema<{
    sessionId: string;
    userId: string | null;
    channel: 'web' | 'telegram';
    // Telegram-only: the chat id the bot must reply into. Populated by the
    // Telegram message handler so chat-respond can route the outbound row.
    telegramChatId?: number | null;
  }>(),
});

export const brainTickRequested = eventType('brain/tick.requested', {
  schema: staticSchema<Record<string, never>>(),
});
