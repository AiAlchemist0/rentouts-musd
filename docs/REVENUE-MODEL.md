# The RentOuts revenue model

One page: how RentOuts makes money, what is live today, and what is only an option.

## Why the escrow is fee-less

The escrow is the product. Its whole value is a promise the two parties can verify themselves: **no owner, no admin key, no fee, no upgrade path** — funds only ever move between the lease's tenant and its landlord. A fee inside the escrow would need someone to collect it, which means an admin and a skimmable pot, and that is exactly the trust the escrow exists to remove. So the on-chain escrow charges nothing, on testnet and in production, permanently: it is deployed immutable and there is no switch to turn on later.

## The 1% landlord portal fee

Revenue comes from the **rentouts.co portals** — the listing and management side — not from the escrow. When MUSD becomes a payment option in the portals, RentOuts charges landlords **1% of rent**, off-chain, alongside the portal's listing and management service. Tenants pay nothing extra, the escrow charges nothing, and nobody pays twice.

**Worked example.** A 2,000 MUSD/month lease:

| | MUSD |
|---|---|
| Rent | 2,000 / month |
| RentOuts fee (1%) | 20 / month |
| Landlord keeps | 1,980 / month |

Over a 12-month lease that is 240 MUSD of revenue from one listing — for rent collection the landlord would otherwise run by hand.

## What is live today

**Nothing charges anything.** The deployed escrow has no fee and cannot gain one. The 1% portal fee is **planned, not live**: it arrives with MUSD payments in the rentouts.co portals (Q1 2027 in the roadmap, invite-only beta leases first). Today RentOuts collects no revenue anywhere — no fee, no take rate, no premium tier.

## Future options — not decided

These are options we may evaluate later. None is agreed, built, or promised:

- **Stability Pool yield on idle deposits.** Rent sits in escrow for months; a per-lease vault could put the idle portion into Mezo's Stability Pool and share what it earns between the tenant and landlord. We fact-checked the protocol source first: see [STABILITY-POOL-CHECK.md](STABILITY-POOL-CHECK.md) — the pool pays **BTC gains from liquidations** and takes **MUSD losses**, it is not a risk-free yield, and a withdrawal gate applies while any trove is undercollateralized. Not for now: the wrong risk for a deposit the tenant must get back in full.
- **Pay-monthly funding.** Letting tenants fund the deposit plus one period at a time instead of prepaying the whole term (the remaining Wave-2 roadmap item). Changes how much MUSD a lease holds, not how RentOuts earns.
- **Portal features.** Listing promotion, management tooling, verified-renter credentials — ordinary marketplace revenue on the rentouts.co side.

## What we will not do

- **No tenant-side fee.** Renters already carry the borrow cost of their trove.
- **No fee inside the escrow.** That is the trust model, and it is immutable.
