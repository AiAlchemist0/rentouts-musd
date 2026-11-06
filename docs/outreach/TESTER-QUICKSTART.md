# Try RentOuts on Mezo testnet (10 minutes)

> **Draft status:** not sent. The founder shares it personally with people he knows.

Thanks for helping. Everything here is **testnet**. The BTC comes from a faucet, the MUSD is borrowed against it, and
no real money moves at any point. You need a browser with MetaMask and about ten minutes.

## Five steps

1. **Get testnet BTC.** Copy your MetaMask address and paste it into the Mezo faucet:
   **https://faucet.test.mezo.org** (it has a CAPTCHA). 0.05 BTC is enough for everything below.
2. **Open https://mezo.rentouts.co** and connect MetaMask. Accept the prompt to add and switch to Mezo testnet
   (chain 31611).
3. **Get a lease:** press *Get a monthly lease*. A demo landlord creates a small lease for you: a 20 MUSD deposit and
   3 × 10 MUSD rent, one "month" every 2 minutes.
4. **Pay in MUSD:** press *Borrow 1,800 MUSD and pay* and sign. The escrow opens a Mezo trove from your BTC, mints
   MUSD and funds the lease in one transaction. Before you sign, the app shows your collateral ratio and liquidation
   price.
5. **Run the lease:** every 2 minutes, press *Pay next period from your trove*. Anyone can press *Release rent* to send
   paid rent to the landlord. About 8 minutes after you started, press *Close lease* and the 20 MUSD deposit comes back
   to you.

Done. Afterwards you can repay and close your trove under **Your trove** to get your BTC back. That part is optional.

## If something goes wrong

- **A transaction seems stuck:** the public RPC can be slow. Wait a minute, refresh, and check the explorer link the
  app shows before you try again.
- **"Wrong network":** switch MetaMask to Mezo testnet (chain 31611).
- **Faucet empty or failing:** try again later. You can also tell us and we'll send you some testnet BTC.
- **Out of gas:** gas is paid in BTC. Top up from the faucet and carry on; a paused lease doesn't expire.

The full guide, including the landlord side, is in [ONBOARDING.md](../ONBOARDING.md).

## Afterwards

Please send us three short answers and your wallet address (the questions are in the message you got, or use the
[feedback form](FEEDBACK-FORM.md)). Your wallet address lets us find your lease on-chain. It's public testnet data
anyway, and we only use it to see where the flow worked or broke.
