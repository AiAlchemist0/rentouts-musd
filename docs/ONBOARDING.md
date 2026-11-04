# RentOuts on Mezo testnet — first lease, step by step

A guide for a first-time **tenant** and a first-time **landlord**. Everything below is **testnet**: the BTC is faucet BTC, the MUSD is borrowed from it, and no real money moves anywhere.

You need a browser wallet (MetaMask is what the app targets) and about ten minutes. One wallet is enough to try the tenant side — the app's demo landlord rents to anyone.

---

## 1. Set up once (both roles)

### Add Mezo testnet to your wallet

Open your wallet → *Add a network* → *Add manually*, and enter:

| Field | Value |
|---|---|
| Network name | Mezo Testnet |
| RPC URL | `https://rpc.test.mezo.org` |
| Chain ID | `31611` |
| Currency symbol | BTC |
| Block explorer | `https://explorer.test.mezo.org` |

These values come from Mezo's own docs ([Connect your wallet to Mezo](https://mezo.org/docs/users/getting-started/connect)); that page can also add the network for you through [Chainlist](https://chainlist.org/chain/31611). The RentOuts app offers to add and switch to the network on first use, so you can skip this step and accept the wallet's prompt instead.

### Get testnet BTC

1. Copy your wallet address.
2. Request BTC from the official Mezo faucet: **https://faucet.test.mezo.org** (it asks you to solve a CAPTCHA; Mezo's [developer guide](https://mezo.org/docs/developers/getting-started) links it, and Mezo's [borrow guide](https://mezo.org/docs/users/borrow/mint-musd) suggests asking on their Discord if you need more).
3. **0.05 BTC covers everything** in this guide — gas is paid in BTC, and the borrow step below sizes itself to what you have.

Optional: add the MUSD token to your wallet so balances are visible — address `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (the same address Mezo's docs list for testnet).

---

## 2. Tenant: your first lease

Open **https://mezo.rentouts.co** and connect your wallet. The app walks the lease top to bottom; each step is one tab.

1. **Get a lease** → *Get a prepaid lease* or *Get a monthly lease*. The demo landlord creates a lease with you as the tenant: a **20 MUSD deposit** and **3 × 10 MUSD** rent, one period every 120 seconds. A prepaid lease funds the deposit plus all three periods in one payment; a monthly one starts with the deposit plus the first period, and the rest is paid period by period. (For a real landlord's lease they enter your address when creating it; it then shows up in the same tab.)
2. **Pay in MUSD** → *Borrow 1,800 MUSD and pay*. You sign **one Mezo borrow message**, and the escrow itself opens (or draws on) your own trove and pays the lease with the minted MUSD in a single transaction. Before you sign, the app shows the BTC price, your **collateral ratio**, the fee, and the **liquidation price**; if anything is short of what the lease needs, the whole transaction reverts, so nothing is left half-funded. Your BTC stays locked in **your own Mezo trove** — nobody else can move it, and you can repay and withdraw it at any time. (Mezo's minimum trove is **1,800 MUSD**, plus a 0.1% borrow fee and a 200 MUSD gas reserve you get back when the trove closes. The **Borrow MUSD** tab does the borrow on its own, without paying a lease.)
3. Or pay with MUSD you already hold: *Approve* the amount, then *Pay with my MUSD*. A prepaid lease takes the **deposit plus all rent** in one payment; a monthly lease takes the deposit plus the first period, and each later period the same way while it is due.
4. **Run the lease** → after a period passes (two minutes on the demo lease), *Release rent*. Anyone can press it; the MUSD only ever goes to the landlord. On a monthly lease, pay each next period with *Pay next period from your trove* — one signature per period, drawn from your trove. When the term plus one period is over, *Close lease* — the **20 MUSD deposit comes straight back** to your wallet.

### The escrow behind the app

The app runs the Wave-2 escrow, `RentEscrowV2` ([`0xE9c9230DE785504c7D383EfEC46cfCa328e257e4`](https://explorer.test.mezo.org/address/0xE9c9230DE785504c7D383EfEC46cfCa328e257e4), verified on Sourcify): the Wave-1 behaviour — create, fund, release rent per period, close, dispute — plus three unhappy-ending paths.

- **Monthly leases and defaults.** If you stop paying a monthly lease, one full period past a period's due date the landlord can close it: they keep the funded rent not yet claimed plus **at most one period's rent from your deposit**, and the rest of the deposit comes back to you.
- **Mutual early termination.** Either side can propose a split with an agreed penalty to the landlord; when the other accepts, the lease closes. No arbiter needed, and nothing settles unless both of you signed the exact terms.
- **Dispute timeout.** A dispute the arbiter doesn't rule on can be settled by anyone after the timeout — 600 seconds on testnet, 30 days planned for production: the landlord gets the rent earned up to the dispute, you get the rest.

Leases made on the Wave-1 escrow stay readable under **Run the lease**.

Status: if you want to lease with us on testnet, reach out at **partners@rentouts.co**. The Wave-2 escrow has a proof-of-personhood gate built in; on testnet it is open, so every wallet can fund.

### Manage your trove (the **Your trove** tab)

Everything about your loan is on one panel:

- **BTC locked (still yours)** and **MUSD owed**, with your **collateral ratio** and the BTC price you'd be **liquidated below**.
- **Add BTC** — post more collateral to raise your ratio.
- **Repay MUSD** — burn debt to raise your ratio.
- **Withdraw BTC** — take collateral back when your ratio has room.
- **Close trove** — repay everything and get all your BTC back.

**Recovery Mode, in plain words.** Mezo watches one number for the whole system: all BTC in all troves against all MUSD owed. If that total ratio falls below **150%**, Mezo enters Recovery Mode and **pauses new borrowing** everywhere. Leases already funded keep running — the rent is already in the escrow — and you can still add BTC or repay on your own trove; borrowing more is off the table until the system recovers, and taking collateral out needs extra headroom while it lasts.

**Liquidation, in plain words.** If your own ratio falls below **110%**, anyone can liquidate your trove: your locked BTC covers the MUSD you owe (a small slice of the collateral goes to the caller as a bounty). The app aims at **160%** when it sizes a borrow, which leaves room for roughly a 30% BTC drop before the line — and the panel shows how far the price can fall before it.

---

## 3. Landlord: list a lease

1. Set up your wallet on Mezo testnet as in section 1.
2. **Ask us to allowlist your address.** Creating a lease mints 100 lease shares to the landlord through `LeaseShare1155` (Wave 2: [`0x4E55dD9d8A41C0CCF21C1FCF70d63A1c4453089E`](https://explorer.test.mezo.org/address/0x4E55dD9d8A41C0CCF21C1FCF70d63A1c4453089E)), and that contract only lets **allowlisted addresses** receive shares — a compliance gate, not a permission on your money. Send your address to **partners@rentouts.co** and we'll allowlist it. (The demo landlord is already allowlisted, so tenants can run a full lease today without waiting on this.)
3. **Create a lease** (the *Get a lease* tab, landlord side): the tenant's 0x address, the **deposit**, the **rent per period**, the **period length** (60 seconds minimum on testnet), the **number of periods**, and **how the tenant pays** — *Prepay everything* or *Pay monthly*. Example: 20 MUSD deposit, 10 MUSD rent, 120-second periods, 3 periods — the demo lease.
4. **Wait for the tenant to fund it.** A prepaid lease activates when the tenant pays deposit + all rent in one payment; a monthly one activates with the deposit plus the first period. Nothing is owed to you before that, and you can cancel an unfunded lease.
5. **Run it.** Each period, *Release rent* (or anyone can — it only ever pays you). On a monthly lease, the tenant pays each next period from their trove; if a period stays unpaid one full period past its due date, you can **claim default**: you keep the funded rent not yet claimed plus at most one period's rent from the deposit, the tenant gets the rest of the deposit, and the lease closes. After the term you can close the lease at once and the remaining rent comes to you; anyone else can close it one period later. That one-period grace is your window to **open a dispute** (for example over damage) before the deposit goes back.

**If something goes wrong.** An open dispute freezes what is left in escrow for a neutral arbiter to split — the arbiter can never be a party to the lease and cannot touch a healthy lease. On the Wave-2 escrow a dispute that the arbiter doesn't resolve **times out** — 600 seconds on testnet, 30 days planned for production — and settles mechanically: you get the rent earned up to the dispute, the tenant gets the rest. The Wave-2 escrow also adds **mutual early termination**: either of you proposes a split with an agreed penalty to you, the other accepts, and the lease closes — no arbiter needed. Either side can walk away early without holding the lease hostage.

---

## 4. What can go wrong

- **Your ratio gets low.** A BTC price drop eats your headroom. Watch the *Your trove* panel: add BTC or repay MUSD well before the liquidation price. If it crosses 110%, the trove is liquidated and the BTC covers the debt.
- **Recovery Mode.** Below a 150% system ratio, new borrowing pauses (including the borrow-and-pay path). Repay and add-collateral still work, and you can still pay a lease with MUSD you already hold. If Mezo is in Recovery Mode when you want to start, wait it out — nothing on the rent side is affected.
- **RPC hiccups.** A transaction that seems to hang is usually the public RPC being slow: give it a minute, refresh, and check the explorer link the app shows before retrying — never resubmit blind. If the wallet says "wrong network", switch to Mezo testnet (chain 31611).
- **Faucet trouble.** The faucet is CAPTCHA-protected and occasionally out of funds. Retry later or ask on Mezo's Discord, as their docs suggest.
- **Keep a little BTC for gas.** Every step costs a dust of BTC. If gas runs out mid-flow, top up from the faucet and continue; leases don't expire because you paused.
- **The demo lease runs fast.** One period every two minutes means rent releases within two minutes and the term is over quickly — that's for testing. A real lease sets day/week/month periods.
