/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SEPOLIA_RPC_URL?: string
  readonly VITE_MEZO_RPC_URL?: string
  /** `mezo` points the demo at Mezo testnet. Anything else stays on Ethereum Sepolia. */
  readonly VITE_CHAIN?: string
  readonly VITE_ESCROW_ADDRESS?: string
  readonly VITE_LEASE_SHARE_ADDRESS?: string
  readonly VITE_CREDENTIAL_SYNC_ADDRESS?: string
  readonly VITE_TOKEN_ADDRESS?: string
  readonly VITE_AI_ARBITER_ADDRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
