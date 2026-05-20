'use client';

import { useRef, useState } from 'react';
import { ChatHeader } from '@/components/app/ChatHeader';
import { ChatPanel, type ChatPanelHandle } from '@/components/app/ChatPanel';
import { Sidebar } from '@/components/app/Sidebar';
import { bumpDailyCount, readDailyCount } from '@/lib/dailyMessageCount';

export default function AppPage() {
  const [wallet, setWallet] = useState<string | undefined>();
  const [messagesUsed, setMessagesUsed] = useState<number>(() =>
    readDailyCount(),
  );
  const chatRef = useRef<ChatPanelHandle>(null);

  function newChat() {
    chatRef.current?.reset();
    // Deliberately do NOT reset messagesUsed — daily quota carries across
    // chats. Starting a new session shouldn't refund usage.
  }

  function onMessageSent() {
    setMessagesUsed(bumpDailyCount());
  }

  return (
    <main className="grid h-screen w-full grid-cols-[280px_1fr] overflow-hidden">
      <Sidebar
        messagesUsed={messagesUsed}
        walletConnected={!!wallet}
        onNewChat={newChat}
      />

      <div className="flex min-h-0 flex-col">
        <ChatHeader walletAddress={wallet} onWalletConnect={setWallet} />
        <ChatPanel ref={chatRef} onMessageSent={onMessageSent} />
      </div>
    </main>
  );
}
