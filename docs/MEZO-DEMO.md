# Mezo lease demo evidence (Wave 1 and Wave 2)

Two MUSD leases on Mezo testnet (chain 31611), 2026-10-23.

| Role | Address |
|---|---|
| Landlord | `0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6` |
| Tenant | `0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1` |
| Arbiter (not a party) | `0x1da334A5FaB59a741fDAE7f081c7f592027b3106` |
| Escrow | [`0xA9f09366991E6df87855F4B99025911790d4C3aF`](https://explorer.test.mezo.org/address/0xA9f09366991E6df87855F4B99025911790d4C3aF) |
| LeaseShare1155 | [`0xfE8bF13ed62A473277d841b0DEDf7720C3DBc820`](https://explorer.test.mezo.org/address/0xfE8bF13ed62A473277d841b0DEDf7720C3DBc820) |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |

The landlord's MUSD was minted by borrowing against testnet BTC: `openTrove(2000e18)` with 0.045 BTC collateral, zero hints — [`0x037283b2…917b`](https://explorer.test.mezo.org/tx/0x037283b2380752c8ce1c58df1a11ebd0e2a3c8b8ca3316d2b50905ef5466917b).

## Lease #1 — full lifecycle (closed)

Terms: deposit **20 MUSD**, rent **10 MUSD / 60s**, **2** periods. Tenant prepaid 40 MUSD.

| Step | Tx | Result |
|---|---|---|
| Transfer 900 MUSD to tenant | [`0x7e5f58f9…1322`](https://explorer.test.mezo.org/tx/0x7e5f58f9a9639ee0c3e8822356ad6733b6af953d4b80daeee8147710b3ce1322) | Tenant can fund both leases |
| createLease | [`0x5c819992…92ed`](https://explorer.test.mezo.org/tx/0x5c8199923d447762e3328682c0018834a393ba369b8932d6b513f751184a92ed) | Lease #1 + 100 shares |
| approve 40 MUSD | [`0x736b0466…70e0`](https://explorer.test.mezo.org/tx/0x736b04667527e41f772f575dcdc4ef34119a439bdde3a325980bf035052470e0) | Tenant → escrow |
| fundLease(1) | [`0x3bd42097…9690`](https://explorer.test.mezo.org/tx/0x3bd42097117b0277f2d44e90bcc07ab757c0c1e5c0d95fbd49995602eaa89690) | 40 MUSD locked |
| claimRent(1) | [`0xe3dddf8d…02ef`](https://explorer.test.mezo.org/tx/0xe3dddf8d66a9a19c3fe675b2ce524a230a33c34b951409ea6394645db63302ef) | Landlord +10 MUSD (period 1) |
| closeLease(1) | [`0x0ca9fcd7…1c87`](https://explorer.test.mezo.org/tx/0x0ca9fcd7661273512c8fffd0a708d51a817a0fe6878e4ef4396c62eb1cb71c87) | Tenant +20 deposit, landlord +10 remaining rent |

`escrowBalance(1)` = 0 after close.

## Lease #2 — running through judging (active)

Terms: deposit **100 MUSD**, rent **50 MUSD / day**, **14** periods. Tenant prepaid 800 MUSD on 2026-10-23 07:25 UTC; the term ends 2026-11-06.

| Step | Tx | Result |
|---|---|---|
| createLease | [`0x2f0dd40f…c9f7`](https://explorer.test.mezo.org/tx/0x2f0dd40f50ad94a28935af4acdc7802d59fd28bfa3df51a1d1d40a960ce7c9f7) | Lease #2 + 100 shares |
| approve 800 MUSD | [`0x83a9e5cf…9073`](https://explorer.test.mezo.org/tx/0x83a9e5cfac8fc6048e653994f6edc739d9e87b1070eb02682e7e988b0f449073) | Tenant → escrow |
| fundLease(2) | [`0xd1d5088b…6532`](https://explorer.test.mezo.org/tx/0xd1d5088b7956bee94ce8ca5bc85a38ff4e63fcb3e5c0bca00b0f7ba00b116532) | 800 MUSD locked |

`claimable(2)` grows by one period (50 MUSD) per day. The deposit stays locked until the lease closes.

## Wave 2 — a pay-monthly lease paid from the tenant's own trove (closed)

2026-11-04, on the pay-monthly RentEscrowV2. Every MUSD the tenant paid in was minted from their Mezo trove **inside the escrow call**, using a `WithdrawMUSD` signature relayed by Mezo's `BorrowerOperationsSignatures`. No separate borrow step, and no MUSD from the wallet balance.

| Role | Address |
|---|---|
| Tenant (trove owner) | `0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6` |
| Landlord | DemoLandlordV2 [`0x8Cf3F01E8ec43791758768d72993D192A87653Ed`](https://explorer.test.mezo.org/address/0x8Cf3F01E8ec43791758768d72993D192A87653Ed) |
| Escrow | RentEscrowV2 [`0xE9c9230DE785504c7D383EfEC46cfCa328e257e4`](https://explorer.test.mezo.org/address/0xE9c9230DE785504c7D383EfEC46cfCa328e257e4) (dispute timeout 600 s) |
| LeaseShare1155 | [`0x4E55dD9d8A41C0CCF21C1FCF70d63A1c4453089E`](https://explorer.test.mezo.org/address/0x4E55dD9d8A41C0CCF21C1FCF70d63A1c4453089E) |
| Mezo relay | BorrowerOperationsSignatures `0xD757e3646AF370b15f32EB557F0F8380Df7D639e` |

Terms: monthly lease #1, deposit **20 MUSD**, rent **10 MUSD per 120 s period**, **3** periods. Funding covers deposit + one period (30 MUSD); each later period is drawn from the trove when it is paid.

| Step | Tx | Result |
|---|---|---|
| requestLease(monthly) | [`0x61c41ac4…f693`](https://explorer.test.mezo.org/tx/0x61c41ac4abb9a17d8a8922010a9b9d8f60429eb8ff34b5270aa08a2f32e3f693) | Monthly lease #1 created by DemoLandlordV2 |
| withdrawAndFund(1, 30 MUSD) | [`0xc9999b35…0c76`](https://explorer.test.mezo.org/tx/0xc9999b35b0f8562c9c208052ad21835efa1e1a29870c62c8f7711a215b420c76) | 30 MUSD minted from the trove into the escrow; lease ACTIVE, 1 period funded |
| withdrawAndPayRent(1, 1 period) | [`0x2c0c8520…29e3`](https://explorer.test.mezo.org/tx/0x2c0c852045df9a57a08863e4023bd675f9f25cccf8fec9ee048fb25fc4c029e3) | Period 2 paid: 10 MUSD minted from the trove, escrow 40 MUSD |
| claimRent(1) | [`0xb09eea22…96eb`](https://explorer.test.mezo.org/tx/0xb09eea228d6b221f2208a0ef7991defd71201a417b6e341940ef77e0589396eb) | Landlord +10 MUSD (period 1) |
| withdrawAndPayRent(1, 1 period) | [`0x9ee4a8bc…ee6e`](https://explorer.test.mezo.org/tx/0x9ee4a8bc700f1bda9e319970286870a60a5a010b7c2fceccbe531b050f65ee6e) | Period 3 paid; lease fully funded |
| closeLease(1) | [`0x351e388c…3b1a`](https://explorer.test.mezo.org/tx/0x351e388cf96457804b77299351441ebfc61f0a9877ac00414d927f4285c33b1a) | Landlord +20 MUSD (periods 2–3), tenant +20 MUSD deposit back; `escrowBalance(1)` = 0 |
| repayMUSD(50.05) on Mezo | [`0xf5e087ba…b8d4`](https://explorer.test.mezo.org/tx/0xf5e087baf31961631fbc78934549ed5e0f400f15a7d78efdce9aab265097b8d4) | Tenant repays the drawn MUSD + fees; trove ratio back to 149.8% |

Trove before: 0.045 BTC collateral, ratio 149.5%, Mezo not in Recovery Mode (system ratio 281%). Every draw was checked against that first. The landlord ends with 30 MUSD of rent and the tenant gets the 20 MUSD deposit back. The proof transactions passed zero position hints, so each trove draw used about 5.3M gas; the app computes real hints from Mezo's HintHelpers.
