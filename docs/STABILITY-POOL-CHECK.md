# Stability Pool — can a rental deposit live there?

A fact check for the roadmap option "put idle escrow deposits into Mezo's Stability Pool and share the yield". Every claim below was read directly from the **mezo-org/musd** source at `main`, commit **`da7888a10949c8a5d3f884454cec8978cfa87e48`** (2026-10-26), fetched 2026-11-04: [`solidity/contracts/StabilityPool.sol`](https://github.com/mezo-org/musd/blob/da7888a10949c8a5d3f884454cec8978cfa87e48/solidity/contracts/StabilityPool.sol), [`TroveManager.sol`](https://github.com/mezo-org/musd/blob/da7888a10949c8a5d3f884454cec8978cfa87e48/solidity/contracts/TroveManager.sol), [`BorrowerOperations.sol`](https://github.com/mezo-org/musd/blob/da7888a10949c8a5d3f884454cec8978cfa87e48/solidity/contracts/BorrowerOperations.sol) and [`dependencies/LiquityBase.sol`](https://github.com/mezo-org/musd/blob/da7888a10949c8a5d3f884454cec8978cfa87e48/solidity/contracts/dependencies/LiquityBase.sol). Line numbers refer to that commit. We read the code, not chain state — see [What this check does not cover](#what-this-check-does-not-cover).

TL;DR: a contract **can** deposit and withdraw freely — except that **withdrawals of MUSD are blocked while any trove in the system is undercollateralized** (ICR < 110%), deposits **lose MUSD and gain BTC pro-rata when liquidations hit**, and there is **no lockup, no fee, no minimum — and no MUSD yield anywhere in the contract**. Verdict for a per-lease vault: **with conditions** — capped idle portion only, never the whole deposit, with a written loss/gain settlement policy and an early-withdrawal plan.

---

## (a) Can a contract call `provideToSP` / `withdrawFromSP` freely?

**Yes — neither function restricts the caller.** Both are plain `external` functions and the depositor is simply `msg.sender`:

- `provideToSP(uint256 _amount)` — `StabilityPool.sol:139`. The only requirement is a non-zero amount (`_requireNonZeroAmount`, `StabilityPool.sol:140`, defined at `:686–688`). It pulls MUSD from the caller with `transferFrom` (`StabilityPool.sol:365–370`), so a vault must `approve` the Stability Pool first, and it **also pays out the depositor's accrued BTC gain on every deposit call** (`StabilityPool.sol:163`, `_sendCollateralGainToDepositor` at `:402–412`).
- `withdrawFromSP(uint256 _amount)` — `StabilityPool.sol:172`. Requires the caller to have a deposit (`:177`). No own-trove requirement, no minimum, no allowlist. One real requirement: the call pays out any accrued gains in **native BTC on the spot** (`:203`), so a depositor contract must be able to accept BTC.

A contract — our hypothetical `DepositVault` — is therefore a first-class depositor. The pool's `receive()` only accepts BTC from the ActivePool (`StabilityPool.sol:95–99`), so nothing can be smuggled in; deposits go through `provideToSP` only.

## (b) Is `withdrawFromSP` blocked while undercollateralized troves exist?

**Yes — exactly the Liquity v1 rule survived into Mezo's fork.** Withdrawing a non-zero amount calls `_requireNoUnderCollateralizedTroves` (`StabilityPool.sol:173–175`), which (`StabilityPool.sol:565–573`):

1. fetches the current BTC price,
2. takes the **last trove in the sorted list** — the riskiest one in the system,
3. reverts if its ICR is below **MCR = 110%** (`LiquityBase.sol:22`) with the message `"StabilityPool: Cannot withdraw while there are troves with ICR < MCR"`.

So one undercollateralized trove anywhere **locks MUSD withdrawals for every depositor** — us included — until it is liquidated, healed, or the price recovers. Two details soften it:

- `withdrawFromSP(0)` skips the check (`:173`) and still pays out accrued **BTC gains** (`:203`) — gains are never locked.
- `withdrawCollateralGainToTrove` (`:210–245`) also moves the BTC gain without the gate, but only into the depositor's own **active** trove (`:216`, `:663–669`).

Borrower-side operations have no equivalent lock: `BorrowerOperations` guards borrowing with ICR/TCR checks instead (for example `openTrove`'s Recovery-Mode branch, `BorrowerOperations.sol:654–663`). The lock is specific to leaving the pool.

## (c) What happens to a deposit when liquidations hit

Liquidation flow: `TroveManager.liquidate` → `batchLiquidateTroves` (`TroveManager.sol:265–271`, `:654`), which liquidates troves with **ICR < 110%** (`:1148`), then splits each liquidation between the pool and the surviving troves (`:696–707`):

- **To the Stability Pool — `offset`** (`StabilityPool.sol:252`, callable **only** by TroveManager, `:257`): the liquidated debt cancels against pool deposits pro-rata. Per unit staked, the depositor loses `debtToOffset / totalDeposits` MUSD — with the loss rounded **up** by one unit to favour the pool (`:448–452`) — and gains `collToAdd / totalDeposits` BTC (`:414–466`). The offset debt is burned (`:481`) and the liquidated BTC moves into the pool (`:483`).
- A depositor's **compounded deposit** is `initial × P / P₀` (`getCompoundedMUSDDeposit`, `:322–337`, formula at `:319`) and their **BTC gain** is `d₀ × (S − S₀) / P₀` (`getDepositorCollateralGain`, `:298–314`, formula at `:294`). If an offset ever **empties the whole pool**, the epoch counter increments and every deposit made before it compounds to **zero** (`:584–587`; the loss-per-unit is set to 100% in that case, `:441–443`).
- Before the offset, the liquidator takes **200 MUSD** gas compensation plus **0.5%** of the collateral (`TroveManager.sol:1080–1085`, `MUSD_GAS_COMPENSATION` and `PERCENT_DIVISOR` in `LiquityBase.sol:28,30,98`), so the pool shares in ~99.5% of the collateral.
- **What the pool can't cover is redistributed, not lost by us:** if a liquidated trove's debt exceeds the pool's total deposits, the excess debt **and** the leftover collateral are spread over all *active troves* (`_getOffsetAndRedistributionVals`, `TroveManager.sol:1581–1607`; `_redistributeDebtAndColl`, `:980`). The pool takes up to its full balance — never more.

**What this means for a per-lease vault.** The vault is just another depositor, so every liquidation shrinks its compounded MUSD and accrues BTC to it at the same pool-wide rate:

- **BTC gains** sit in the pool until the vault claims them (`provideToSP` pays them on every top-up, `withdrawFromSP(0)` claims them without the gate, `withdrawCollateralGainToTrove` re-troves them). Settlement question the vault must answer in code: **gains belong to the tenant** (they replace the MUSD the deposit lost) — or are shared with the landlord if the landlord is being paid for bearing part of the risk. Either way the vault must claim actively and account per lease.
- **MUSD losses** hit whoever the vault owes the deposit to. On a healthy lease the deposit is slated to return to the tenant at move-out — so an unhedged loss silently reduces the tenant's refund. The policy has to be explicit: does the loss land on the tenant, on the landlord's rent, or on RentOuts? Nothing in the protocol decides it.
- **Correlated risk:** the scenario that produces pool losses — a BTC price crash — is the same scenario that pushes *the tenant's own trove* toward liquidation and can trigger Recovery Mode, which **also blocks the vault's own withdrawals** (see (b)). Deposit loss, tenant liquidation and withdrawal lock arrive together, not independently.
- The deposit's term is fixed but its exposure is not: offset size depends on what the *rest of the system* liquidates while the lease runs. A deposit parked for a 12-month term can eat several liquidation cycles it never chose.

## (d) Lockup, fee, minimum — and where the "yield" actually comes from

- **No lockup.** Deposits can be withdrawn (subject to the (b) gate) at any time; `withdrawFromSP` takes `min(amount, compounded)` (`:184–187`).
- **No fee.** Nothing in deposit or withdrawal paths charges anything; no exit fee, no management cut.
- **No minimum.** Only "amount > 0" (`:140`, `:686–688`).
- **No MUSD yield in the contract.** This is the finding most easily assumed wrong: Mezo's StabilityPool keeps only the collateral-gain sum `S` and the loss product `P` (`Snapshots`, `:28–33`; state `:47–79`). Liquity v1's MUSD issuance-gain accumulator (`G`) and front-end kickback mappings **do not exist here**. A depositor's only on-chain income is **BTC from liquidations**; its only on-chain expense is **MUSD lost to liquidations**. Any MUSD-denominated reward would have to come from a separate Mezo-level program — none is visible in this source (unconfirmed, see below).

Context for sizing the opportunity, all from the same source: MCR **110%**, CCR **150%** (`LiquityBase.sol:22,25`, Recovery Mode = TCR < CCR at `:91`); borrowing fee 0.1% set at deployment (`BorrowerOperations.sol:146`); code-level minimum net debt floor 50 MUSD (`BorrowerOperations.sol:97`) with the actual testnet minimum of 1,800 MUSD configured by setter — 1,800 is what the repo's README and app use, we did not verify chain state; trove interest accrues per trove via `InterestRateManager` (Mezo's docs state initial rates of 1–5%; the repo README says 1%/year on testnet) and interest is offset against pool deposits exactly like principal (`TroveManager.sol:1592`). Redemption also plays: `redeemCollateral` is blocked unless TCR > MCR (`:318`) and skips troves below MCR (`:374–378`).

## Recommendation: with conditions — and never the whole deposit

A per-lease `DepositVault` in the Stability Pool is **not a plain yes**: the deposit is money that owes itself back to the tenant on a fixed date, and the pool can lock withdrawals on that date, shave the principal in a crash, and (in the extreme) compound a deposit to zero. It is a **yes, with conditions** if used as a yield top-up on a capped idle slice:

1. **Cap it.** Only the unearned-rent portion, and only a bounded fraction — never the deposit-reserved slice a move-out must repay. If the pool itself can be emptied by offsets, no fraction is truly safe; the cap bounds damage, it does not remove the risk.
2. **Plan the exit.** Withdrawals in tranches well before move-out, treating `withdrawFromSP` as *usually available, never guaranteed*. The vault must not let a lease settlement depend on a same-day withdrawal succeeding.
3. **Write the settlement policy before the first deposit:** BTC gains credited to the tenant (or shared with the landlord under an explicit risk-shifting terms line); MUSD losses landing on a named party; accounting per lease, claimed and settled through the vault, since the pool only ever talks to `msg.sender`.
4. **Receive BTC.** Gains arrive as native BTC (`:203`, `:402–412`); the vault needs a `receive()` (or a treasury claim path) or every gain claim reverts.
5. **Re-check before production:** this is one commit of a fast-moving fork, and production could deploy a different revision — re-run this check against the deployed mainnet addresses and compare.

For a rental product whose headline promise is "the deposit comes back at move-out", parking the *deposit* in this pool contradicts the promise. Parking the *idle earnings* under these conditions is defensible on testnet — and still marked **not decided** in [REVENUE-MODEL.md](REVENUE-MODEL.md).

## What this check does not cover

Read from source only; not verified against live chain state:

- The **deployed testnet addresses** of StabilityPool/TroveManager/BorrowerOperations were not inspected — the code above is `mezo-org/musd@main`, and the testnet deployment could differ.
- **Current on-chain parameters**: actual `minNetDebt` on testnet, current borrowing fee, current interest rate, pool size and recent liquidation history — all read from chain, not code.
- **Any Mezo-level reward program** layered on top of the Stability Pool (apps, incentives, points): invisible in this source; presence or absence unconfirmed.
- **Gas costs** of claim/withdraw cycles for a vault that settles many leases.

## Sources

- mezo-org/musd @ `da7888a10949c8a5d3f884454cec8978cfa87e48` (main, 2026-10-26): `solidity/contracts/StabilityPool.sol`, `solidity/contracts/TroveManager.sol`, `solidity/contracts/BorrowerOperations.sol`, `solidity/contracts/dependencies/LiquityBase.sol` — line numbers as cited above.
- Mezo docs: [borrow guide](https://mezo.org/docs/users/borrow/mint-musd) (interest 1–5%, MUSD addresses), [wallet connect](https://mezo.org/docs/users/getting-started/connect) (testnet params).
- This repo: README (`RentEscrowV2 (Wave 2)`, Limitations), [REVENUE-MODEL.md](REVENUE-MODEL.md).
