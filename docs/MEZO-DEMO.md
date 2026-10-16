# Mezo Wave 1 — lease #1 demo evidence

One full MUSD lease on Mezo testnet (chain 31611), 2026-10-16.

| Role | Address |
|---|---|
| Landlord | `0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6` |
| Tenant | `0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1` |
| Arbiter (not a party) | `0x6edaCc23181829E228427167bD22c0c199e9eF08` |
| Escrow | [`0x25C37b5A05a21A743F04B455122f24aA55235047`](https://explorer.test.mezo.org/address/0x25C37b5A05a21A743F04B455122f24aA55235047) |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |

Terms: lease **#1**, deposit **20 MUSD**, rent **10 MUSD / 60s**, **2** periods. Tenant prepaid 40 MUSD.

| Step | Tx | Result |
|---|---|---|
| openTrove 2000 MUSD, 0.045 BTC collateral, zero hints | [`0x037283b2…917b`](https://explorer.test.mezo.org/tx/0x037283b2380752c8ce1c58df1a11ebd0e2a3c8b8ca3316d2b50905ef5466917b) | Landlord minted 2000 MUSD |
| BTC gas to tenant | [`0x67cf543a…2942`](https://explorer.test.mezo.org/tx/0x67cf543a999a7763d08c90ef5871a07a77e566cfba5581be2fa857082dc82942) | 0.001 BTC |
| Transfer 50 MUSD to tenant | [`0xccf79c56…6c7e`](https://explorer.test.mezo.org/tx/0xccf79c560c5b99e5a917dfb3d20ce8aa79de3a839a0f78e25a9bafbdc0516c7e) | Tenant can fund |
| createLease | [`0x6c2f52f1…b526`](https://explorer.test.mezo.org/tx/0x6c2f52f151492e8134c97a9bac55dc1bc3f7b27f33d7bde16e2132b9cb09b526) | Lease #1 + 100 shares |
| approve 40 MUSD | [`0x551c2162…f1f7`](https://explorer.test.mezo.org/tx/0x551c2162677b4bb60928a9dfb09d95c18cff6bce0cdd8858c2fc6900088ff1f7) | Tenant → escrow |
| fundLease(1) | [`0x7b775b10…4e55`](https://explorer.test.mezo.org/tx/0x7b775b105199f4e3a9ae37a59891b224e1f3f11c58ed2d32167dcdd3f34c4e55) | 40 MUSD locked |
| claimRent(1) | [`0x25eec87c…2876`](https://explorer.test.mezo.org/tx/0x25eec87ca931c6352828dee4757519a9aabcc975664e14b18924e87f45df2876) | Landlord +10 MUSD |
| closeLease(1) | [`0xe10dc5cd…fd84`](https://explorer.test.mezo.org/tx/0xe10dc5cd704756b2b2124ac7853878b87a5ff27d497348f69f8833228b54fd84) | Tenant +20 deposit, landlord +10 remaining rent |

Final balances (on-chain): landlord **1970 MUSD**, tenant **30 MUSD**, escrow **0**. `getLease(1).state` = CLOSED (4). `escrowBalance(1)` = 0.
