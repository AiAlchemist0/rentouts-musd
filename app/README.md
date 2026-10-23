# RentOuts MUSD — lease app

The lease demo for Mezo testnet: create a lease, pay deposit and rent in MUSD, watch rent unlock, close and get the deposit back.

**Hosted:** https://mezo.rentouts.co

Contract addresses are read at build time from [`../deployments.json`](../deployments.json) (`mezoTestnet`). The app holds no keys or secrets.

## Try it

1. Add Mezo testnet to MetaMask (chain id 31611, RPC `https://rpc.test.mezo.org`). The app offers to switch.
2. Get testnet BTC for gas from https://faucet.test.mezo.org.
3. Get MUSD: borrow it against your BTC, or swap BTC for MUSD, at https://testnet.mezo.org.
4. **Create a lease** as the landlord, naming the tenant's address.
5. **Fund the lease** from the tenant wallet: approve, then "Pay rent in MUSD — Bitcoin-backed".
6. **Run the lease**: rent unlocks period by period; close it after the term and the deposit returns to the tenant.

Lease #2 on the live escrow runs until 6 Nov 2026, so the *Run the lease* tab shows rent unlocking without a wallet.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test
npm run build      # static output in dist/
```

The ENS and AI-judge screens in the source belong to the Ethereum Sepolia build of RentOuts and are switched off on Mezo.
