import type { Abi } from 'viem'
import artifact from './MUSD.json'

/** Testnet MUSD ABI, copied from rentouts-contracts/.mezo/MUSD.json. 18 decimals. */
export const musdAbi = artifact.abi as Abi
