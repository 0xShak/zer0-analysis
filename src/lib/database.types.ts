// Hand-rolled Supabase types matching supabase/migrations/0001_initial.sql.
// Regenerate after applying the migration:
//   supabase gen types typescript --linked > src/lib/database.types.ts

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          wallet_address: string | null;
          telegram_user_id: number | null;
          display_name: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          wallet_address?: string | null;
          telegram_user_id?: number | null;
          display_name?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          wallet_address?: string | null;
          telegram_user_id?: number | null;
          display_name?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      sessions: {
        Row: {
          id: string;
          user_id: string | null;
          anon_fingerprint: string | null;
          channel: 'web' | 'telegram';
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          anon_fingerprint?: string | null;
          channel: 'web' | 'telegram';
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          anon_fingerprint?: string | null;
          channel?: 'web' | 'telegram';
          created_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: number;
          session_id: string | null;
          user_id: string | null;
          role: 'user' | 'assistant' | 'system';
          channel: string;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          session_id?: string | null;
          user_id?: string | null;
          role: 'user' | 'assistant' | 'system';
          channel: string;
          content: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          session_id?: string | null;
          user_id?: string | null;
          role?: 'user' | 'assistant' | 'system';
          channel?: string;
          content?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      thoughts: {
        Row: {
          id: number;
          market_condition_id: string | null;
          scope: 'public' | 'app';
          content: string;
          tokens_in: number | null;
          tokens_out: number | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          market_condition_id?: string | null;
          scope: 'public' | 'app';
          content: string;
          tokens_in?: number | null;
          tokens_out?: number | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          market_condition_id?: string | null;
          scope?: 'public' | 'app';
          content?: string;
          tokens_in?: number | null;
          tokens_out?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      x_posts: {
        Row: {
          id: number;
          kind: 'signal' | 'digest';
          ref_id: string;
          tweet_id: string | null;
          content: string | null;
          posted_at: string;
        };
        Insert: {
          id?: number;
          kind: 'signal' | 'digest';
          ref_id: string;
          tweet_id?: string | null;
          content?: string | null;
          posted_at?: string;
        };
        Update: {
          id?: number;
          kind?: 'signal' | 'digest';
          ref_id?: string;
          tweet_id?: string | null;
          content?: string | null;
          posted_at?: string;
        };
        Relationships: [];
      };
      x_mentions: {
        Row: {
          mention_id: string;
          author: string | null;
          text: string | null;
          status: 'pending' | 'replied' | 'skipped_ungrounded' | 'rate_capped';
          reply_id: string | null;
          created_at: string;
        };
        Insert: {
          mention_id: string;
          author?: string | null;
          text?: string | null;
          status?: 'pending' | 'replied' | 'skipped_ungrounded' | 'rate_capped';
          reply_id?: string | null;
          created_at?: string;
        };
        Update: {
          mention_id?: string;
          author?: string | null;
          text?: string | null;
          status?: 'pending' | 'replied' | 'skipped_ungrounded' | 'rate_capped';
          reply_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      x_mention_cursor: {
        Row: {
          id: number;
          since_id: string | null;
          updated_at: string;
        };
        Insert: {
          id?: number;
          since_id?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: number;
          since_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      market_catalog_cache: {
        Row: {
          id: number;
          markets: Json;
          market_count: number;
          updated_at: string;
        };
        Insert: {
          id?: number;
          markets?: Json;
          market_count?: number;
          updated_at?: string;
        };
        Update: {
          id?: number;
          markets?: Json;
          market_count?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      trade_recommendations: {
        Row: {
          id: string;
          market_condition_id: string;
          market_question: string | null;
          token_id: string;
          side: 'BUY' | 'SELL';
          price: number;
          size: number;
          conviction: number;
          rationale: string;
          neg_risk: boolean;
          status: string;
          created_at: string;
          expires_at: string | null;
          resolved_at: string | null;
          winning_token_id: string | null;
          resolution_price: number | null;
          is_correct: boolean | null;
          realized_pnl_usd: number | null;
          mark_price: number | null;
          mark_pnl_usd: number | null;
          settled_at: string | null;
        };
        Insert: {
          id?: string;
          market_condition_id: string;
          market_question?: string | null;
          token_id: string;
          side: 'BUY' | 'SELL';
          price: number;
          size: number;
          conviction: number;
          rationale: string;
          neg_risk?: boolean;
          status?: string;
          created_at?: string;
          expires_at?: string | null;
          resolved_at?: string | null;
          winning_token_id?: string | null;
          resolution_price?: number | null;
          is_correct?: boolean | null;
          realized_pnl_usd?: number | null;
          mark_price?: number | null;
          mark_pnl_usd?: number | null;
          settled_at?: string | null;
        };
        Update: {
          id?: string;
          market_condition_id?: string;
          market_question?: string | null;
          token_id?: string;
          side?: 'BUY' | 'SELL';
          price?: number;
          size?: number;
          conviction?: number;
          rationale?: string;
          neg_risk?: boolean;
          status?: string;
          created_at?: string;
          expires_at?: string | null;
          resolved_at?: string | null;
          winning_token_id?: string | null;
          resolution_price?: number | null;
          is_correct?: boolean | null;
          realized_pnl_usd?: number | null;
          mark_price?: number | null;
          mark_pnl_usd?: number | null;
          settled_at?: string | null;
        };
        Relationships: [];
      };
      entitlements: {
        Row: {
          id: string;
          user_id: string | null;
          session_id: string | null;
          unlocked_until: string;
          source: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          unlocked_until: string;
          source: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          unlocked_until?: string;
          source?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          user_id: string | null;
          session_id: string | null;
          coinbase_charge_id: string | null;
          status: string | null;
          amount_usd: number | null;
          created_at: string;
          confirmed_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          coinbase_charge_id?: string | null;
          status?: string | null;
          amount_usd?: number | null;
          created_at?: string;
          confirmed_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          coinbase_charge_id?: string | null;
          status?: string | null;
          amount_usd?: number | null;
          created_at?: string;
          confirmed_at?: string | null;
        };
        Relationships: [];
      };
      rate_limits: {
        Row: { fingerprint: string; day: string; count: number };
        Insert: { fingerprint: string; day?: string; count?: number };
        Update: { fingerprint?: string; day?: string; count?: number };
        Relationships: [];
      };
      market_scans: {
        Row: {
          condition_id: string;
          question: string | null;
          last_seen_at: string;
          deterministic: boolean | null;
          category: string | null;
          classifier_confidence: number | null;
          classifier_reason: string | null;
          last_analyzed_at: string | null;
          last_analyzed_yes_price: number | null;
        };
        Insert: {
          condition_id: string;
          question?: string | null;
          last_seen_at?: string;
          deterministic?: boolean | null;
          category?: string | null;
          classifier_confidence?: number | null;
          classifier_reason?: string | null;
          last_analyzed_at?: string | null;
          last_analyzed_yes_price?: number | null;
        };
        Update: {
          condition_id?: string;
          question?: string | null;
          last_seen_at?: string;
          deterministic?: boolean | null;
          category?: string | null;
          classifier_confidence?: number | null;
          classifier_reason?: string | null;
          last_analyzed_at?: string | null;
          last_analyzed_yes_price?: number | null;
        };
        Relationships: [];
      };
      inbound_messages: {
        Row: {
          id: number;
          channel: 'web' | 'telegram';
          session_id: string | null;
          user_id: string | null;
          content: string;
          processed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          channel: 'web' | 'telegram';
          session_id?: string | null;
          user_id?: string | null;
          content: string;
          processed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          channel?: 'web' | 'telegram';
          session_id?: string | null;
          user_id?: string | null;
          content?: string;
          processed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      agent_usage: {
        Row: {
          id: number;
          provider: string;
          model: string;
          tokens_in: number;
          tokens_out: number;
          cached_tokens: number;
          cost_usd: number;
          step: string | null;
          brain_tick_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          provider: string;
          model: string;
          tokens_in: number;
          tokens_out: number;
          cached_tokens?: number;
          cost_usd: number;
          step?: string | null;
          brain_tick_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          provider?: string;
          model?: string;
          tokens_in?: number;
          tokens_out?: number;
          cached_tokens?: number;
          cost_usd?: number;
          step?: string | null;
          brain_tick_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      link_codes: {
        Row: {
          code: string;
          session_id: string | null;
          user_id: string | null;
          created_at: string;
          expires_at: string;
          consumed_at: string | null;
        };
        Insert: {
          code: string;
          session_id?: string | null;
          user_id?: string | null;
          created_at?: string;
          expires_at?: string;
          consumed_at?: string | null;
        };
        Update: {
          code?: string;
          session_id?: string | null;
          user_id?: string | null;
          created_at?: string;
          expires_at?: string;
          consumed_at?: string | null;
        };
        Relationships: [];
      };
      outbound_messages: {
        Row: {
          id: number;
          channel: 'web' | 'telegram';
          session_id: string | null;
          user_id: string | null;
          telegram_chat_id: number | null;
          content: string;
          delivered_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          channel: 'web' | 'telegram';
          session_id?: string | null;
          user_id?: string | null;
          telegram_chat_id?: number | null;
          content: string;
          delivered_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          channel?: 'web' | 'telegram';
          session_id?: string | null;
          user_id?: string | null;
          telegram_chat_id?: number | null;
          content?: string;
          delivered_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      trades: {
        Row: {
          id: string;
          user_id: string | null;
          session_id: string | null;
          recommendation_id: string | null;
          user_address: string;
          market_condition_id: string;
          token_id: string;
          side: 'BUY' | 'SELL';
          price: number;
          size_usd: number;
          signature_type: number;
          order_payload: Json | null;
          signed_order: Json | null;
          status:
            | 'pending'
            | 'prepared'
            | 'submitted'
            | 'accepted'
            | 'rejected'
            | 'filled'
            | 'cancelled'
            | 'failed';
          clob_order_id: string | null;
          failure_reason: string | null;
          prepared_at: string;
          submitted_at: string | null;
          accepted_at: string | null;
          filled_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          recommendation_id?: string | null;
          user_address: string;
          market_condition_id: string;
          token_id: string;
          side: 'BUY' | 'SELL';
          price: number;
          size_usd: number;
          signature_type: number;
          order_payload?: Json | null;
          signed_order?: Json | null;
          status?:
            | 'pending'
            | 'prepared'
            | 'submitted'
            | 'accepted'
            | 'rejected'
            | 'filled'
            | 'cancelled'
            | 'failed';
          clob_order_id?: string | null;
          failure_reason?: string | null;
          prepared_at?: string;
          submitted_at?: string | null;
          accepted_at?: string | null;
          filled_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          session_id?: string | null;
          recommendation_id?: string | null;
          user_address?: string;
          market_condition_id?: string;
          token_id?: string;
          side?: 'BUY' | 'SELL';
          price?: number;
          size_usd?: number;
          signature_type?: number;
          order_payload?: Json | null;
          signed_order?: Json | null;
          status?:
            | 'pending'
            | 'prepared'
            | 'submitted'
            | 'accepted'
            | 'rejected'
            | 'filled'
            | 'cancelled'
            | 'failed';
          clob_order_id?: string | null;
          failure_reason?: string | null;
          prepared_at?: string;
          submitted_at?: string | null;
          accepted_at?: string | null;
          filled_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      tg_wc_sessions: {
        Row: {
          telegram_user_id: number;
          session_topic: string;
          eoa_address: string;
          funder_address: string;
          signature_type: number;
          wallet_type: 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';
          needs_onboarding: boolean;
          expires_at: string;
          created_at: string;
          last_used_at: string;
        };
        Insert: {
          telegram_user_id: number;
          session_topic: string;
          eoa_address: string;
          funder_address: string;
          signature_type: number;
          wallet_type: 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';
          needs_onboarding?: boolean;
          expires_at: string;
          created_at?: string;
          last_used_at?: string;
        };
        Update: {
          telegram_user_id?: number;
          session_topic?: string;
          eoa_address?: string;
          funder_address?: string;
          signature_type?: number;
          wallet_type?: 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';
          needs_onboarding?: boolean;
          expires_at?: string;
          created_at?: string;
          last_used_at?: string;
        };
        Relationships: [];
      };
      tg_pending_trades: {
        Row: {
          id: string;
          telegram_user_id: number;
          chat_id: number;
          message_id: number | null;
          state:
            | 'INTENT_PARSED'
            | 'AWAITING_USER_CONFIRM'
            | 'AWAITING_WALLET_SIG'
            | 'SUBMITTED'
            | 'DONE'
            | 'CANCELLED'
            | 'EXPIRED';
          trade_id: string | null;
          intent_json: Json;
          typed_data: Json | null;
          wallet_meta: Json | null;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          telegram_user_id: number;
          chat_id: number;
          message_id?: number | null;
          state:
            | 'INTENT_PARSED'
            | 'AWAITING_USER_CONFIRM'
            | 'AWAITING_WALLET_SIG'
            | 'SUBMITTED'
            | 'DONE'
            | 'CANCELLED'
            | 'EXPIRED';
          trade_id?: string | null;
          intent_json: Json;
          typed_data?: Json | null;
          wallet_meta?: Json | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          telegram_user_id?: number;
          chat_id?: number;
          message_id?: number | null;
          state?:
            | 'INTENT_PARSED'
            | 'AWAITING_USER_CONFIRM'
            | 'AWAITING_WALLET_SIG'
            | 'SUBMITTED'
            | 'DONE'
            | 'CANCELLED'
            | 'EXPIRED';
          trade_id?: string | null;
          intent_json?: Json;
          typed_data?: Json | null;
          wallet_meta?: Json | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tg_clob_api_creds: {
        Row: {
          telegram_user_id: number;
          signer_address: string;
          api_key: string;
          api_secret: string;
          api_passphrase: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          telegram_user_id: number;
          signer_address: string;
          api_key: string;
          api_secret: string;
          api_passphrase: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          telegram_user_id?: number;
          signer_address?: string;
          api_key?: string;
          api_secret?: string;
          api_passphrase?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      walletconnect_kv: {
        Row: { key: string; value: Json; updated_at: string };
        Insert: { key: string; value: Json; updated_at?: string };
        Update: { key?: string; value?: Json; updated_at?: string };
        Relationships: [];
      };
      pending_sims: {
        Row: {
          id: string;
          channel: 'web' | 'telegram';
          user_id: string | null;
          session_id: string | null;
          telegram_user_id: number | null;
          telegram_chat_id: number | null;
          scenario: string;
          state: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          price_zer0: number | null;
          pay_to_address: string | null;
          pay_tx_hash: string | null;
          paid_at: string | null;
          error: string | null;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          channel: 'web' | 'telegram';
          user_id?: string | null;
          session_id?: string | null;
          telegram_user_id?: number | null;
          telegram_chat_id?: number | null;
          scenario: string;
          state?: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          price_zer0?: number | null;
          pay_to_address?: string | null;
          pay_tx_hash?: string | null;
          paid_at?: string | null;
          error?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          channel?: 'web' | 'telegram';
          user_id?: string | null;
          session_id?: string | null;
          telegram_user_id?: number | null;
          telegram_chat_id?: number | null;
          scenario?: string;
          state?: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          price_zer0?: number | null;
          pay_to_address?: string | null;
          pay_tx_hash?: string | null;
          paid_at?: string | null;
          error?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      pro_orders: {
        Row: {
          id: string;
          wallet_address: string;
          session_id: string | null;
          state: 'AWAITING_PAYMENT' | 'PAID' | 'EXPIRED';
          price_usd: number;
          price_zer0: number;
          // numeric(78,0) — PostgREST returns numeric as a string to preserve
          // precision; these are BigInt-sized, so always read them as strings.
          amount_base_units: string;
          token_address: string;
          pay_to_address: string;
          from_block: string;
          pay_tx_hash: string | null;
          paid_at: string | null;
          entitlement_id: string | null;
          error: string | null;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          wallet_address: string;
          session_id?: string | null;
          state?: 'AWAITING_PAYMENT' | 'PAID' | 'EXPIRED';
          price_usd: number;
          price_zer0: number;
          amount_base_units: string;
          token_address: string;
          pay_to_address: string;
          from_block: string;
          pay_tx_hash?: string | null;
          paid_at?: string | null;
          entitlement_id?: string | null;
          error?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          wallet_address?: string;
          session_id?: string | null;
          state?: 'AWAITING_PAYMENT' | 'PAID' | 'EXPIRED';
          price_usd?: number;
          price_zer0?: number;
          amount_base_units?: string;
          token_address?: string;
          pay_to_address?: string;
          from_block?: string;
          pay_tx_hash?: string | null;
          paid_at?: string | null;
          entitlement_id?: string | null;
          error?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      simulations: {
        Row: {
          id: string;
          pending_sim_id: string | null;
          channel: 'web' | 'telegram';
          user_id: string | null;
          session_id: string | null;
          telegram_chat_id: number | null;
          scenario: string;
          status: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          miroshark_project_id: string | null;
          miroshark_graph_id: string | null;
          miroshark_simulation_id: string | null;
          watch_url: string | null;
          share_card_url: string | null;
          signal_json: Json | null;
          polymarket_json: Json | null;
          summary: string | null;
          error: string | null;
          wall_clock_ms: number | null;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          pending_sim_id?: string | null;
          channel: 'web' | 'telegram';
          user_id?: string | null;
          session_id?: string | null;
          telegram_chat_id?: number | null;
          scenario: string;
          status?: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          miroshark_project_id?: string | null;
          miroshark_graph_id?: string | null;
          miroshark_simulation_id?: string | null;
          watch_url?: string | null;
          share_card_url?: string | null;
          signal_json?: Json | null;
          polymarket_json?: Json | null;
          summary?: string | null;
          error?: string | null;
          wall_clock_ms?: number | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          pending_sim_id?: string | null;
          channel?: 'web' | 'telegram';
          user_id?: string | null;
          session_id?: string | null;
          telegram_chat_id?: number | null;
          scenario?: string;
          status?: | 'AWAITING_PAYMENT' | 'PAID' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
          miroshark_project_id?: string | null;
          miroshark_graph_id?: string | null;
          miroshark_simulation_id?: string | null;
          watch_url?: string | null;
          share_card_url?: string | null;
          signal_json?: Json | null;
          polymarket_json?: Json | null;
          summary?: string | null;
          error?: string | null;
          wall_clock_ms?: number | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      increment_rate_limit: {
        Args: { fp: string; today: string };
        Returns: { fingerprint: string; day: string; count: number };
      };
    };
    Enums: {
      tg_trade_state:
        | 'INTENT_PARSED'
        | 'AWAITING_USER_CONFIRM'
        | 'AWAITING_WALLET_SIG'
        | 'SUBMITTED'
        | 'DONE'
        | 'CANCELLED'
        | 'EXPIRED';
      sim_state:
        | 'AWAITING_PAYMENT'
        | 'PAID'
        | 'RUNNING'
        | 'COMPLETED'
        | 'FAILED'
        | 'EXPIRED'
        | 'CANCELLED';
    };
    CompositeTypes: Record<string, never>;
  };
};
