# RentOuts MUSD

**Keep your bitcoin. Pay your rent.** Long-term rent and deposits paid in **MUSD** on Mezo testnet.

[rentouts.co](https://rentouts.co) is the existing rental marketplace. This repository is the new work for the Mezo Buildathon: the same non-custodial `RentEscrow` contracts, wired to MUSD, Mezo’s Bitcoin-backed stablecoin.

`RentEscrow` takes its settlement token in the constructor. MUSD is that token. The contract does not hold admin keys, does not take a fee, and cannot be upgraded. A tenant prepays the deposit and the rent. Rent unlocks to the landlord one period at a time. At the end, the deposit comes back to the tenant.

![RentOuts on Mezo: keep your bitcoin, pay your rent](docs/img/home.png)

## Try it

**Live app: https://mezo.rentouts.co** — one wallet is enough:

1. **Get a lease** from the demo landlord (a contract that rents to anyone).
2. **Borrow MUSD** against testnet BTC, in the app: it calls Mezo Borrow (`openTrove`, or `withdrawMUSD` on an existing trove) and shows the BTC price, collateral ratio, fee and liquidation price first.
3. **Pay in MUSD**: approve, then prepay the deposit and every period’s rent into the escrow.
4. **Run the lease**: rent releases to the landlord period by period; after the term, close it and the deposit comes back.

Lease #2 is running on the live escrow until 6 Nov, so *Run the lease* shows rent unlocking without a wallet.

| Borrow MUSD against BTC (Mezo Borrow) | A live lease, releasing rent daily |
|---|---|
| ![Borrow step](docs/img/borrow.png) | ![Lease #2](docs/img/live-lease.png) |

Source and steps: [`app/`](app/README.md).

## How MUSD is used

| Where | Mezo / MUSD call |
|---|---|
| Borrow step | `BorrowerOperations.openTrove` / `withdrawMUSD`, hints from `HintHelpers.getApproxHint` + `SortedTroves.findInsertPosition`, price from the Mezo `PriceFeed` |
| Pay step | `MUSD.approve` → `RentEscrow.fundLease` pulls deposit + all rent in MUSD |
| Run step | `RentEscrow.claimRent` releases MUSD to the landlord per period; `closeLease` returns the MUSD deposit |

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

Live `mezoTestnet` (source verified on Sourcify, exact match):

| Contract | Address |
|---|---|
| RentEscrow | [`0xA9f09366991E6df87855F4B99025911790d4C3aF`](https://explorer.test.mezo.org/address/0xA9f09366991E6df87855F4B99025911790d4C3aF) |
| LeaseShare1155 | [`0xfE8bF13ed62A473277d841b0DEDf7720C3DBc820`](https://explorer.test.mezo.org/address/0xfE8bF13ed62A473277d841b0DEDf7720C3DBc820) |
| DemoLandlord | [`0x6621dE90776302aD1a3C0190141f9169B4A0112B`](https://explorer.test.mezo.org/address/0x6621dE90776302aD1a3C0190141f9169B4A0112B) — 20 MUSD deposit, 10 MUSD / 60s × 3 |
| Arbiter | `0x1da334A5FaB59a741fDAE7f081c7f592027b3106` |
| Human gate | none |

**Lease #1** (closed): 20 MUSD deposit, 10 MUSD / 60s × 2 periods. Landlord claimed one period; tenant closed and got the deposit back.

| Step | Tx |
|---|---|
| Mint 2000 MUSD (`openTrove`) | [`0x037283b2…917b`](https://explorer.test.mezo.org/tx/0x037283b2380752c8ce1c58df1a11ebd0e2a3c8b8ca3316d2b50905ef5466917b) |
| createLease | [`0x5c819992…92ed`](https://explorer.test.mezo.org/tx/0x5c8199923d447762e3328682c0018834a393ba369b8932d6b513f751184a92ed) |
| fundLease | [`0x3bd42097…9690`](https://explorer.test.mezo.org/tx/0x3bd42097117b0277f2d44e90bcc07ab757c0c1e5c0d95fbd49995602eaa89690) |
| claimRent | [`0xe3dddf8d…02ef`](https://explorer.test.mezo.org/tx/0xe3dddf8d66a9a19c3fe675b2ce524a230a33c34b951409ea6394645db63302ef) |
| closeLease | [`0x0ca9fcd7…1c87`](https://explorer.test.mezo.org/tx/0x0ca9fcd7661273512c8fffd0a708d51a817a0fe6878e4ef4396c62eb1cb71c87) |

**Lease #2** (active until 6 Nov 2026): 100 MUSD deposit, 50 MUSD / day × 14 periods, 800 MUSD prepaid. Rent unlocks to the landlord one day at a time; read it live with `getLease(2)` and `claimable(2)`.

| Step | Tx |
|---|---|
| createLease | [`0x2f0dd40f…c9f7`](https://explorer.test.mezo.org/tx/0x2f0dd40f50ad94a28935af4acdc7802d59fd28bfa3df51a1d1d40a960ce7c9f7) |
| fundLease | [`0xd1d5088b…6532`](https://explorer.test.mezo.org/tx/0xd1d5088b7956bee94ce8ca5bc85a38ff4e63fcb3e5c0bca00b0f7ba00b116532) |

Full log: [docs/MEZO-DEMO.md](docs/MEZO-DEMO.md).

## Limitations (honest list)

**Getting MUSD takes real BTC.** Mezo's minimum trove is 1,800 MUSD (plus a 0.1% fee and a 200 MUSD gas reserve that comes back when the trove closes). At about $81k per BTC that needs roughly 0.037 BTC at 150% and 0.049 BTC at 200%: about $3,000–4,000 of BTC, even for a small lease. Mezo's testnet faucet gives 0.05 BTC, which the app sizes for. Mezo charges 1% a year on the trove. Already holding MUSD skips all of this.

**The whole lease is prepaid.** `RentEscrow` takes the deposit and every period's rent in one transaction. That is what makes rent impossible to miss for the landlord, but a 12-month, $2,000 lease means 26,000 MUSD up front (about 0.64 BTC at 200%).

**The tenant carries the BTC price risk, the landlord does not.** The BTC is in the tenant's own Mezo trove, not in the escrow: RentOuts and the landlord cannot touch it, and the tenant can repay and withdraw it at any time. What protects the landlord is the MUSD already in escrow. If BTC falls far enough, the tenant's trove can be liquidated or redeemed against, but the lease keeps paying the landlord.

**Breaking a lease goes through a dispute.** There is no mutual early termination yet. A tenant who moves out early, a landlord who needs the unit back, or a unit that is not as promised: either side opens a dispute, which freezes what is left in escrow until the arbiter splits it. Rent already released stays released; damage beyond what is left in escrow is not covered on-chain. A dispute has no timeout, so the arbiter must stay available (one key on testnet; a multisig is planned).

**Local rules on deposits and prepaid rent vary.** Some jurisdictions cap deposits or prepaid rent, or require deposits held in trust with interest. A production lease has to fit the local rules; this testnet escrow does not check them.

**Testnet, not audited.** No real funds, no external audit yet. `DemoLandlord` exists only so one wallet can try the tenant side.

**Next (Wave 2):** pay monthly instead of prepaying the whole term (deposit plus the next period, topped up as it goes), mutual early termination with an agreed penalty, a dispute timeout, and borrow-and-pay in one transaction.

## Run the tests

[Foundry](https://book.getfoundry.sh/) is required.

```bash
forge install
forge test        # 104 tests, including the RentEscrow invariant suite
cd app && npm install && npm test   # app: trove math, deployments, copy
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

### DemoLandlord

```bash
ESCROW=<RentEscrow address> forge script script/DeployDemoLandlord.s.sol --profile mezo --rpc-url mezo_testnet \
  --account <keystore-name> --sender <deployer-address> --broadcast
```

Then the LeaseShare1155 owner allowlists it once (`setAllowlist(demoLandlord, true)`): creating a lease mints its shares to the landlord.

## License

MIT. OpenZeppelin Contracts v5.1.0 is included as a library under its own license.
