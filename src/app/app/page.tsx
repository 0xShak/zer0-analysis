'use client';

import { useRef, useState } from 'react';
import { ChatHeader } from '@/components/app/ChatHeader';
import { ChatPanel, type ChatPanelHandle } from '@/components/app/ChatPanel';
import { Sidebar } from '@/components/app/Sidebar';

export default function AppPage() {
  const [wallet, setWallet] = useState<string | undefined>();
  const [messagesUsed, setMessagesUsed] = useState(0);
  const chatRef = useRef<ChatPanelHandle>(null);

  function newChat() {
    chatRef.current?.reset();
    setMessagesUsed(0);
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
        <ChatPanel ref={chatRef} onUsageChange={setMessagesUsed} />
      </div>
    </main>
  );
}
