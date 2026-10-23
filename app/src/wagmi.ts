import { createConfig, http } from 'wagmi'
import { sepolia } from 'wagmi/chains'
// From @wagmi/core, not wagmi/connectors, which would pull every wallet SDK into the bundle.
import { injected } from '@wagmi/core'
import { MEZO_RPC_URL, SEPOLIA_RPC_URL } from './config'
import { mezoTestnet } from './network'

/** Sepolia stays available for ENS reads. Lease writes follow VITE_CHAIN. */
export const wagmiConfig = createConfig({
  chains: [sepolia, mezoTestnet],
  connectors: [injected()],
  multiInjectedProviderDiscovery: false,
  transports: {
    [sepolia.id]: http(SEPOLIA_RPC_URL, { batch: { batchSize: 20 } }),
    [mezoTestnet.id]: http(MEZO_RPC_URL, { batch: { batchSize: 20 } }),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
