// Polymarket contract addresses on Polygon mainnet (chainId 137).
//
// Sourced from the installed SDK config at
//   node_modules/@polymarket/clob-client/dist/config.js:9-15
// so this list stays auditable against the version we depend on.
//
// Polymarket uses USDC.e (the bridged-from-Ethereum USDC, NOT Circle's
// native Polygon USDC at 0x3c499…). Users holding native USDC must swap to
// USDC.e before any order can settle — the Exchange contract only accepts
// the bridged variant as collateral.

export const POLYGON_CHAIN_ID = 137;

export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const USDC_E_DECIMALS = 6;

export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

export function exchangeForMarket(negRisk: boolean): string {
  return negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
}
