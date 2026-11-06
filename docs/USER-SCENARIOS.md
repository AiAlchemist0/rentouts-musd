# Who RentOuts on Mezo is for — illustrative scenarios

> **These people are illustrative, not real users.** RentOuts on Mezo has no outside users yet. Every lease on-chain so
> far is the team's own demo (see [MEZO-DEMO.md](MEZO-DEMO.md)). The scenarios below show who the product is built for
> and what a lease costs them, using real contract rules and stated assumptions. Outside users are the Wave 3 goal.

**Assumptions used throughout** (change them and the shape stays the same):

- BTC at **$75,000**; 1 MUSD = $1.
- Mezo borrowing fee **0.1%** (as shown in the app), a **200 MUSD** gas reserve added to trove debt, Mezo's
  minimum trove debt of 1,800 MUSD, liquidation below **110%** collateral.
- Interest **3% a year**, inside Mezo's quoted 1–5% range, charged on the debt actually outstanding.
- The app never suggests a ratio below 160%; the scenarios aim for **200%**.

---

## 1 · The tenant who holds bitcoin and doesn't want to sell it

*Illustrative.* A software contractor rents a $2,000-a-month flat for 12 months with a $2,000 deposit. They hold BTC
and would rather keep it than sell it to pay rent.

**Without RentOuts:** sell about **0.35 BTC** up front for the deposit and the year's rent (26,000 USD), and no longer
own that bitcoin if the price rises.

**With RentOuts, pay-monthly from their own trove:**

| | |
|---|---|
| Day 1 | One signature: the escrow mints **4,000 MUSD** (deposit + first month) from the tenant's trove and funds the lease in the same transaction |
| Each later month | One signature: `withdrawAndPayRent` mints that month's **2,000 MUSD** straight into the escrow |
| Debt at the end of the year | about **26,226 MUSD** (26,000 + 0.1% fee + 200 gas reserve) |
| BTC kept in the trove for 200% | about **0.70 BTC**, still the tenant's |
| Liquidation price at the end | about **$41,200** (BTC can fall about 45% before liquidation). The app shows this live, with add-BTC and repay one click away |
| Interest over the year | about **$450**: the debt grows from 4,000 to 26,000, averaging 15,000 |
| Same lease prepaid on day 1 | about **$780** interest: the full 26,000 owed all year |
| At move-out | the 2,000 MUSD deposit comes straight back from the escrow, with no landlord holding it |

Paying monthly saves this tenant about **$330** in interest against prepaying, and no prepaid MUSD sits idle in the
escrow. This is our answer to the Wave 1 feedback about idle MUSD.

## 2 · The landlord with a few units on rentouts.co

*Illustrative.* An owner lists three flats on rentouts.co at $1,800 a month each, on 12-month leases.

| | Per month | Per year |
|---|---|---|
| Rent across the three units | 5,400 MUSD | 64,800 MUSD |
| RentOuts portal fee (1%, off-chain, landlord side) | 54 MUSD | 648 MUSD |
| Landlord keeps | 5,346 MUSD | 64,152 MUSD |

What they get for the 1%:

- Rent unlocks to them **period by period on a fixed schedule**, with no chasing late payments.
- **No deposit to hold or argue over.** It sits in the escrow and returns automatically at the end, unless they open
  a dispute during the grace window.
- **A capped default rule**: if a tenant stops paying, they claim the funded rent plus **one month** from the deposit,
  enforced by the contract.

The escrow itself charges nothing, and tenants pay nothing to RentOuts. See [REVENUE-MODEL.md](REVENUE-MODEL.md).

## 3 · The tenant moving countries

*Illustrative.* A researcher moves abroad for a 9-month position. They have no local credit history, and a landlord
asks for a large deposit they'd normally wire to a stranger.

- The deposit goes into the escrow, not the landlord's account. Neither side can take it alone.
- If the job ends early, `proposeTermination` / `acceptTermination` lets them leave by agreement on exact,
  hash-bound terms. No arbiter, no lawyer.
- If a dispute stalls, `resolveByTimeout` settles it: earned rent to the landlord, the rest back to the tenant.

## 4 · When things go wrong

*Illustrative.* The same contractor from scenario 1 misses month 7.

- One full period after the due date, the landlord can `claimDefault`. They receive the rent already funded but not
  yet released, plus at most **one month (2,000 MUSD)** from the deposit. **Unpaid future rent is never reachable**,
  and the tenant gets the remaining deposit back.
- If BTC falls sharply instead, the **Your trove** panel shows the ratio and liquidation price live, and lets the
  tenant add BTC or repay MUSD in one transaction each. In Recovery Mode the app blocks new borrowing and explains why;
  funded leases keep running.

---

## What is real today

| Real | Not yet |
|---|---|
| The escrow, the one-signature borrow-and-pay paths and every rule above, live on Mezo testnet and verified on Sourcify | Any outside tenant or landlord |
| Team demo leases covering each path: monthly, termination, timeout, one-transaction borrow, default rules in tests ([MEZO-DEMO.md](MEZO-DEMO.md)) | The 1% portal fee (planned with MUSD in the rentouts.co portals, Q1 2027) |
| The rentouts.co long-term rental marketplace | Mainnet and an external audit (Q2 2027) |

**Wave 3 goal:** first outside tenants and landlords on testnet, starting with rentouts.co landlords and the Mezo
community (drafts in [outreach/](outreach/)).
