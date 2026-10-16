# RentOuts MUSD

Rent deposits and rent, paid in **MUSD** on Mezo testnet.

[rentouts.co](https://rentouts.co) is the existing rental marketplace. This repository is the new work for the Mezo Buildathon: the same non-custodial `RentEscrow` contracts, wired to MUSD, Mezo’s Bitcoin-backed stablecoin.

`RentEscrow` takes its settlement token in the constructor. MUSD is that token. The contract does not hold admin keys, does not take a fee, and cannot be upgraded. A tenant prepays the deposit and the rent. Rent unlocks to the landlord one period at a time. At the end, the deposit comes back to the tenant.

## Network

| | |
|---|---|
| Chain | Mezo testnet, id **31611** |
| RPC | `https://rpc.test.mezo.org` |
| Explorer | https://explorer.test.mezo.org |
| Gas | BTC |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (**18 decimals**) |
| Faucet | https://faucet.test.mezo.org |

MUSD is minted by borrowing against testnet BTC (`BorrowerOperations.openTrove`), or by swapping inside https://testnet.mezo.org. ABIs for those public contracts are in `.mezo/`.

Live `mezoTestnet` (verified on the explorer):

| Contract | Address |
|---|---|
| RentEscrow | [`0x25C37b5A05a21A743F04B455122f24aA55235047`](https://explorer.test.mezo.org/address/0x25C37b5A05a21A743F04B455122f24aA55235047) |
| LeaseShare1155 | [`0x2be778f3F3724b74fc64E49e05c848FcCB4e6Fb4`](https://explorer.test.mezo.org/address/0x2be778f3F3724b74fc64E49e05c848FcCB4e6Fb4) |
| Arbiter | `0x6edaCc23181829E228427167bD22c0c199e9eF08` |
| Human gate | none |

**Lease #1** (closed): 20 MUSD deposit, 10 MUSD / 60s × 2 periods. Landlord claimed one period; tenant closed and got the deposit back.

| Step | Tx |
|---|---|
| Mint 2000 MUSD (`openTrove`) | [`0x037283b2…917b`](https://explorer.test.mezo.org/tx/0x037283b2380752c8ce1c58df1a11ebd0e2a3c8b8ca3316d2b50905ef5466917b) |
| createLease | [`0x6c2f52f1…b526`](https://explorer.test.mezo.org/tx/0x6c2f52f151492e8134c97a9bac55dc1bc3f7b27f33d7bde16e2132b9cb09b526) |
| fundLease | [`0x7b775b10…4e55`](https://explorer.test.mezo.org/tx/0x7b775b105199f4e3a9ae37a59891b224e1f3f11c58ed2d32167dcdd3f34c4e55) |
| claimRent | [`0x25eec87c…2876`](https://explorer.test.mezo.org/tx/0x25eec87ca931c6352828dee4757519a9aabcc975664e14b18924e87f45df2876) |
| closeLease | [`0xe10dc5cd…fd84`](https://explorer.test.mezo.org/tx/0xe10dc5cd704756b2b2124ac7853878b87a5ff27d497348f69f8833228b54fd84) |

Full log: [docs/MEZO-DEMO.md](docs/MEZO-DEMO.md).

## Run the tests

[Foundry](https://book.getfoundry.sh/) is required.

```bash
forge install
forge test
```

## Deploy

Use a Foundry keystore account. Do not pass a raw private key, and do not commit a keystore.

```bash
ESCROW_TOKEN=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 \
ESCROW_ARBITER=<arbiter-address> \
ESCROW_HUMAN_GATE=none \
forge script script/DeployEscrow.s.sol --profile mezo --rpc-url mezo_testnet \
  --account <keystore-name> --sender <deployer-address> --broadcast
```

`ESCROW_HUMAN_GATE=none` leaves funding ungated on this escrow (a gate cannot be added later). A future deploy can pass a `HumanGate`; that gate never holds tokens and never touches a lease that is already funded.

A successful broadcast adds a `mezoTestnet` entry to `deployments.json`. The `baseSepolia` key already in that file is a placeholder so the script's read-modify-write can be tested. It is not a live deployment.

## License

MIT. OpenZeppelin Contracts v5.1.0 is included as a library under its own license.
