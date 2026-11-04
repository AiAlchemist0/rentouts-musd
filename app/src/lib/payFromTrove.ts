import type { Address } from 'viem'
import { borrowerOperationsSignaturesAbi } from '../abi/mezo'
import { troveHints } from '../hooks'
import { mezoSignaturesDomain, signatureDeadline, withdrawMusdTypes, type WithdrawMusdMessage } from './mezoSignatures'
import type { useDemoClient } from '../hooks'

/**
 * Paying out of an existing Mezo trove, shared by the funding paths in FundPanel (withdrawAndFund)
 * and the pay-monthly card in LeasesPanel (withdrawAndPayRent): the WithdrawMUSD permission signing
 * with its trove hints, so every caller sends exactly the same two-step flow — sign a permission
 * first (no gas), then send the one escrow transaction. How much the trove can safely carry is
 * withdrawQuote in lib/trove.
 */

/** The borrower's nonce, read fresh from Mezo's relay right before signing (any spent signature bumps it). */
export async function readNonce(
  client: ReturnType<typeof useDemoClient>,
  signatures: Address,
  account: Address,
): Promise<bigint> {
  return client.readContract({
    address: signatures,
    abi: borrowerOperationsSignaturesAbi,
    functionName: 'getNonce',
    args: [account],
  })
}

type SignTypedData = (args: {
  domain: ReturnType<typeof mezoSignaturesDomain>
  types: typeof withdrawMusdTypes
  primaryType: 'WithdrawMUSD'
  message: WithdrawMusdMessage
}) => Promise<`0x${string}`>

/**
 * The whole signing side of a trove payment: the borrower's fresh nonce, their WithdrawMUSD
 * permission for `amount` minted to `recipient`, and the trove hints for the debt it lands at.
 * The caller sends the escrow call itself (withdrawAndFund / withdrawAndPayRent) with the result.
 */
export async function signWithdrawMusd(args: {
  client: ReturnType<typeof useDemoClient>
  account: Address
  /** Mezo's BorrowerOperationsSignatures contract the permission signs against. */
  signatures: Address
  /** Who receives the minted MUSD: the escrow. */
  recipient: Address
  amount: bigint
  /** The trove's collateral and its debt after this mint: what the hints aim at. */
  coll: bigint
  newDebt: bigint
  signTypedDataAsync: SignTypedData
  now: number
}): Promise<{ signature: `0x${string}`; deadline: bigint; upper: Address; lower: Address }> {
  const { client, account, signatures, recipient, amount, coll, newDebt, signTypedDataAsync, now } = args
  const nonce = await readNonce(client, signatures, account)
  const deadline = signatureDeadline(now)
  const signature = await signTypedDataAsync({
    domain: mezoSignaturesDomain(signatures),
    types: withdrawMusdTypes,
    primaryType: 'WithdrawMUSD',
    message: { amount, borrower: account, recipient, nonce, deadline },
  })
  const [upper, lower] = await troveHints(client, coll, newDebt)
  return { signature, deadline, upper, lower }
}
