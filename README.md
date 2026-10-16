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

The escrow address will be added here after the testnet deploy.

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

`ESCROW_HUMAN_GATE=none` leaves funding open. The optional `HumanGate` contract can refuse new funding later. It never holds tokens and never touches a lease that is already funded.

A successful broadcast adds a `mezoTestnet` entry to `deployments.json`. The `baseSepolia` key already in that file is a placeholder so the script's read-modify-write can be tested. It is not a live deployment.

## License

MIT. OpenZeppelin Contracts v5.1.0 is included as a library under its own license.
