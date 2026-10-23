import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// This repo is the Mezo testnet build (MUSD, 18 decimals, BTC gas). VITE_CHAIN=sepolia switches back.
process.env.VITE_CHAIN ??= 'mezo'

export default defineConfig({
  plugins: [react()],
  // Deployment records live one level up: ens/deployments/sepolia.json and the root deployments.json.
  server: { fs: { allow: ['.', '../ens/deployments', '../deployments.json'] } },
  // viem (with the ENSIP-15 normalizer tables) + wagmi + React is ~650 kB; fine for a single-page demo.
  build: { chunkSizeWarningLimit: 800 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
