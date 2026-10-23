import { defineChain } from 'viem'
import { sepolia } from 'wagmi/chains'

/** Mezo testnet. Native gas is BTC. MUSD uses 18 decimals, not USDC's 6. */
export const MEZO_CHAIN_ID = 31_611

export const MUSD_TESTNET = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503' as const

const mezoRpc = import.meta.env.VITE_MEZO_RPC_URL?.trim() || 'https://rpc.test.mezo.org'

export const mezoTestnet = defineChain({
  id: MEZO_CHAIN_ID,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [mezoRpc] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  // Canonical Multicall3, deployed and verified on Mezo testnet. The lease list batches its reads through it.
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  testnet: true,
})

/** Set VITE_CHAIN=mezo to point the lease demo at Mezo testnet. Default stays Ethereum Sepolia. */
export const isMezo = import.meta.env.VITE_CHAIN?.trim().toLowerCase() === 'mezo'

export const demoChain = isMezo ? mezoTestnet : sepolia

export const chainPill = isMezo ? 'Mezo testnet' : 'Sepolia testnet'
export const chainPillTitle = isMezo
  ? `Mezo testnet, chain id ${mezoTestnet.id}, gas in BTC`
  : `Ethereum Sepolia, chain id ${sepolia.id}`
export const switchChainLabel = isMezo ? 'Switch to Mezo' : 'Switch to Sepolia'
export const wrongNetworkCopy = isMezo
  ? `MetaMask is on another network. This demo runs on Mezo testnet (chain id ${mezoTestnet.id}).`
  : `MetaMask is on another network. This demo runs on Ethereum Sepolia (chain id ${sepolia.id}).`
export const switchFirstCopy = isMezo
  ? 'Switch MetaMask to Mezo testnet first.'
  : 'Switch MetaMask to Ethereum Sepolia first.'

/** Shown until decimals() / symbol() are read from the escrow token. */
export const fallbackDecimals = isMezo ? 18 : 6
export const fallbackSymbol = isMezo ? 'MUSD' : 'USDC'

export const gasLabel = isMezo ? 'BTC for gas' : 'Sepolia ETH for gas'
export const explorerLabel = isMezo ? 'Mezo Explorer' : 'Etherscan'
export const confirmWait = isMezo ? 'Waiting for Mezo testnet to confirm.' : 'Waiting for Sepolia to confirm.'
export const connectToCreate = isMezo
  ? 'Connect MetaMask on Mezo testnet to create a lease.'
  : 'Connect MetaMask on Sepolia to create a lease.'
