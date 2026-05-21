// Polymarket V2 contract addresses on Polygon mainnet (chainId 137).
//
// CLOB V2 / CTF Exchange V2 went live on 2026-04-28; V1 contracts no longer
// accept new orders. V2 trades against pUSD (Polymarket USD) — an ERC-20 on
// Polygon backed 1:1 by USDC.e via the CollateralOnramp. Users still hold
// USDC.e initially and must `wrap()` into pUSD before trading.
//
// Sourced from the installed SDK config at
//   node_modules/@polymarket/clob-client-v2/dist/config.js (MATIC_CONTRACTS)
// so this list stays auditable against the version we depend on.

export const POLYGON_CHAIN_ID = 137;

// USDC.e — the bridged-from-Ethereum USDC. Still the input to the Onramp
// wrap; never used directly by V2 Exchange anymore.
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const USDC_E_DECIMALS = 6;

// pUSD — Polymarket USD, the V2 collateral token. Same 6 decimals as USDC.e.
export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
export const PUSD_DECIMALS = 6;

// CollateralOnramp — wraps USDC.e into pUSD. Signature:
//   wrap(address asset, address to, uint256 amount)
// `asset` must be USDC_E_ADDRESS. Caller must first approve() USDC.e to the
// Onramp.
export const COLLATERAL_ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';

// V2 Exchange contracts. EIP-712 domain version "2"; name unchanged
// ("Polymarket CTF Exchange").
export const CTF_EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
export const NEG_RISK_CTF_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59';

// Conditional Tokens framework address — unchanged between V1 and V2.
export const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Deposit Wallet factory + current implementation on Polygon. Sourced from
// `@polymarket/builder-relayer-client/dist/config/index.js` so the values
// stay pinned to whatever the relayer SDK expects. The factory is a singleton
// (CREATE2-deterministic); the implementation can be swapped by Polymarket
// admins, so re-confirm if a future upgrade lands.
export const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
export const DEPOSIT_WALLET_IMPLEMENTATION = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';

// Polymarket's transaction relayer for builders. Sponsors gas for deposit-
// wallet deployment + executeBatch.
export const POLYMARKET_RELAYER_URL = 'https://relayer-v2.polymarket.com/';

export function exchangeForMarket(negRisk: boolean): string {
  return negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2;
}
