// Polymarket deposit-wallet factory constants (post-2026-04-28 V2 CLOB).
//
// The factory at this address mints a deterministic ERC-1271 smart-contract
// wallet per EOA. The wallet address is CREATE2(factory, salt, initCode);
// the init-code/init-hash is currently undocumented by Polymarket, so
// callers that need the predicted address must look it up via the
// data-api `/resolve/<eoa>` endpoint (see resolve-wallet.ts) rather than
// computing it locally.

export const POLYMARKET_DEPOSIT_WALLET_FACTORY =
  '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
