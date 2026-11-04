import type { Address, TypedDataDomain } from 'viem'
import { MEZO_CHAIN_ID } from '../network'

/**
 * The EIP-712 messages RentEscrowV2's one-transaction funding asks the tenant to sign — relayed by
 * Mezo's BorrowerOperationsSignatures, which checks them itself. Shape proven against the live testnet
 * contract by test/RentEscrowV2.fork.t.sol: domain name "BorrowerOperationsSignatures", version "1",
 * chainId 31611, verifyingContract = the signatures contract; the nonce comes from getNonce(borrower),
 * and the recipient (the escrow) receives exactly debtAmount / amount.
 */

/** The domain of Mezo's BorrowerOperationsSignatures at `verifyingContract`. */
export function mezoSignaturesDomain(verifyingContract: Address): TypedDataDomain {
  return { name: 'BorrowerOperationsSignatures', version: '1', chainId: MEZO_CHAIN_ID, verifyingContract }
}

/** OpenTrove(uint256 assetAmount, uint256 debtAmount, address borrower, address recipient, uint256 nonce, uint256 deadline); assetAmount is the BTC collateral attached to the call. */
export const openTroveTypes = {
  OpenTrove: [
    { name: 'assetAmount', type: 'uint256' },
    { name: 'debtAmount', type: 'uint256' },
    { name: 'borrower', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type OpenTroveMessage = {
  /** BTC collateral, in wei: must equal the value sent with borrowAndFund. */
  assetAmount: bigint
  /** MUSD the trove mints to the recipient, in wei. */
  debtAmount: bigint
  borrower: Address
  recipient: Address
  nonce: bigint
  deadline: bigint
}

/** WithdrawMUSD(uint256 amount, address borrower, address recipient, uint256 nonce, uint256 deadline); amount is minted against the borrower's existing trove. */
export const withdrawMusdTypes = {
  WithdrawMUSD: [
    { name: 'amount', type: 'uint256' },
    { name: 'borrower', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type WithdrawMusdMessage = {
  /** MUSD minted to the recipient, in wei. */
  amount: bigint
  borrower: Address
  recipient: Address
  nonce: bigint
  deadline: bigint
}

/** How long a signed trove operation stays valid: enough for a review, short enough not to be replayed casually. */
export const SIGNATURE_LIFETIME = 20 * 60

/** A signature deadline: whole Unix seconds, now + SIGNATURE_LIFETIME. */
export function signatureDeadline(now: number): bigint {
  return BigInt(now + SIGNATURE_LIFETIME)
}
