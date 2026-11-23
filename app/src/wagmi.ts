import { createConfig, http } from 'wagmi'
import { sepolia } from 'wagmi/chains'
// From @wagmi/core, not wagmi/connectors, which would pull every wallet SDK into the bundle.
import { injected } from '@wagmi/core'
import { MEZO_RPC_URL, SEPOLIA_RPC_URL } from './config'
import { mezoTestnet } from './network'

/**
 * Sepolia stays available for ENS reads. Lease writes follow VITE_CHAIN. Mezo testnet's public RPC is
 * load-balanced and sometimes slow, so its requests get an 8 s ceiling and two retries. There is no
 * fallback transport: Mezo's docs ("Connect your wallet" at mezo.org/docs) list only
 * rpc.test.mezo.org as a public testnet HTTPS RPC — the multi-provider endpoints there are mainnet.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia, mezoTestnet],
  connectors: [injected()],
  multiInjectedProviderDiscovery: false,
  transports: {
    [sepolia.id]: http(SEPOLIA_RPC_URL, { batch: { batchSize: 20 } }),
    [mezoTestnet.id]: http(MEZO_RPC_URL, { batch: { batchSize: 20 }, timeout: 8_000, retryCount: 2 }),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
