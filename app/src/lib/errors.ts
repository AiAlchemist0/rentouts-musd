import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Hex,
} from 'viem'
import { aiArbiterAbi } from '../abi/aiArbiter'
import { credentialSyncAbi } from '../abi/credentialSync'
import { erc20Abi } from '../abi/erc20'
import { leaseShareAbi } from '../abi/leaseShare'
import { rentEscrowAbi } from '../abi/rentEscrow'
import { rentEscrowV2Abi } from '../abi/rentEscrowV2'
import { rentoutsSubnamesAbi } from '../abi/rentoutsSubnames'
import { RulingStatus } from './aiJudge'
import { shortAddress, formatToken } from './format'
import { STATE_LABELS } from './lease'

/**
 * Every custom error the app can meet. The escrow bubbles up errors from LeaseShare1155, the token and
 * Mezo's trove contracts (and AIArbiter those of the escrow), so a revert is decoded against all of
 * them, not just the ABI of the contract that was called. Errors both escrows declare (InvalidState,
 * NotParty, …) have identical signatures.
 */
export const knownErrorsAbi = [
  ...rentEscrowAbi,
  ...rentEscrowV2Abi,
  ...aiArbiterAbi,
  ...rentoutsSubnamesAbi,
  ...leaseShareAbi,
  ...erc20Abi,
  ...credentialSyncAbi,
].filter((item) => item.type === 'error')

const leaseRef = (args: readonly unknown[]) => (args[0] !== undefined ? `Lease #${String(args[0])}` : 'This lease')

/** An 18-decimal error argument as MUSD, e.g. "1,550.00"; undefined when it isn't a number. */
const musd = (value: unknown) => {
  try {
    return formatToken(BigInt(value as bigint), 18)
  } catch {
    return undefined
  }
}

/** Why AIArbiter has no open proposal to appeal or execute, by its Status. */
const NO_OPEN_PROPOSAL: Record<number, string> = {
  [RulingStatus.NONE]: 'the AI judge hasn’t proposed a ruling yet',
  [RulingStatus.APPEALED]: 'it was appealed, so only the human arbiter can rule now',
  [RulingStatus.EXECUTED]: 'it was already executed',
  [RulingStatus.HUMAN_RESOLVED]: 'the human arbiter already ruled',
}

/** Plain-language message for a decoded custom error. Unknown errors fall back to their name. */
export function describeError(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    // RentoutsSubnames
    case 'InvalidLabel':
      return 'Use 3–32 lowercase letters, digits or hyphens, not starting or ending with a hyphen.'
    case 'AlreadyHasName':
      return 'This wallet already holds a RentOuts name. Each address gets one.'
    case 'LabelRetired':
      return 'This name was revoked and retired for good. Pick another one.'
    case 'LabelTaken':
      return 'This name is taken. Pick another one.'
    case 'NotAuthorized':
      return 'You can only claim a name for the connected wallet.'
    case 'NotHolder':
      return 'Only the name’s holder can change its profile.'
    case 'UnknownLabel':
      return 'There is no active RentOuts name with this label.'
    case 'ZeroAddress':
      return 'The address can’t be the zero address.'
    case 'NotIssuer':
    case 'NotAdmin':
      return 'Only a RentOuts issuer can do this.'
    // RentEscrow
    case 'InvalidTerms':
      return 'The escrow rejected these terms. Check the amounts, the period length, the number of periods and the tenant address. The arbiter can’t be the landlord or the tenant, and the tenant can’t be the landlord.'
    case 'InvalidState': {
      const state = STATE_LABELS[Number(args[1])] ?? 'in another state'
      return `${leaseRef(args)} is ${state.toLowerCase()}, so this action isn’t available.`
    }
    case 'NotLandlord':
      return `Only the landlord of ${leaseRef(args).toLowerCase()} can do this.`
    case 'NotTenant':
      return `Only the tenant of ${leaseRef(args).toLowerCase()} can do this.`
    case 'NotParty':
      return `Only the landlord or the tenant of ${leaseRef(args).toLowerCase()} can do this.`
    case 'NotArbiter':
      return 'Only the escrow’s arbiter, the AI judge contract, can resolve disputes. Use the AI dispute judge panel.'
    case 'NothingToClaim':
      return 'No rent has unlocked since the last claim. Wait for the next period.'
    case 'TermNotOver':
      return 'The lease term isn’t over yet. Other accounts can close it one period after the term ends.'
    case 'InvalidBps':
      return 'The tenant’s share must be between 0% and 100%.'
    case 'NotVerifiedHuman':
      return `${args[0] ? shortAddress(String(args[0])) : 'This wallet'} hasn’t passed the escrow’s human verification (World ID 4.0: not registered in the gate), so it can’t fund a lease.`
    // RentEscrowV2 (Wave-2)
    case 'MezoDisabled':
      return 'This escrow can’t relay Mezo trove operations, so one-transaction borrowing is off. Pay with MUSD you already have instead.'
    case 'InsufficientBorrowed': {
      const received = musd(args[1])
      const owed = musd(args[2])
      return `The trove operation sent the escrow ${received ?? 'less MUSD'}${owed ? ` of the ${owed} the lease needs` : ''}, so the lease wasn’t funded. The Mezo permission may already have been used elsewhere; sign again, or pay with MUSD you already have.`
    }
    case 'StrayBtc':
      return 'A BTC transfer reached the escrow, which only ever holds MUSD. It was refused and sent back.'
    case 'DisputeNotTimedOut':
      return 'The dispute timeout hasn’t passed yet. Wait for the countdown, or the arbiter can still rule.'
    case 'NoProposal':
      return `${leaseRef(args)} has no open early-end offer (never made, or already withdrawn, replaced or accepted).`
    case 'NotProposer':
      return `Only the wallet that made this early-end offer can withdraw it.`
    case 'ProposalExpired':
      return 'This early-end offer expired before it was accepted. Ask for a fresh one.'
    case 'WrongTermsHash':
      return 'The offer changed on-chain (replaced or renewed). Check the new terms, then accept again.'
    case 'ProposerCannotAccept':
      return 'The wallet that made this offer can’t accept it. The other side must accept.'
    case 'InvalidExpiry':
      return 'The offer’s expiry must be in the future. Pick a longer window.'
    case 'PenaltyTooHigh': {
      const tenantSide = musd(args[2])
      return `The penalty is more than the tenant’s side (unearned rent + deposit)${tenantSide ? `, which is ${tenantSide} MUSD now` : ''}. Lower it and try again.`
    }
    case 'InsufficientUnbooked':
      return 'More MUSD was requested than the unbooked pot holds. Nothing of any lease’s escrow can be moved.'
    // AIArbiter
    case 'NotHuman':
      return 'Only the human arbiter can do this.'
    case 'NotAgent':
      return 'Only the AI judge’s key can propose a ruling.'
    case 'PartyCannotArbitrate':
      return `${args[1] ? shortAddress(String(args[1])) : 'This wallet'} is a party to ${leaseRef(args).toLowerCase()}, so it can’t rule on it.`
    case 'EscrowNotBound':
      return 'The AI judge contract isn’t bound to the escrow yet: the human arbiter calls bindEscrow once.'
    case 'EscrowAlreadyBound':
    case 'NotEscrowArbiter':
      return 'The AI judge contract is bound to one escrow only, whose arbiter must be that contract.'
    case 'NotDisputed': {
      const state = STATE_LABELS[Number(args[1])] ?? 'in another state'
      return `${leaseRef(args)} is ${state.toLowerCase()}, not in dispute.`
    }
    case 'InvalidStatementLength':
      return Number(args[0] ?? 0) === 0
        ? 'Write a statement first.'
        : `The statement is ${Number(args[0]).toLocaleString('en-US')} bytes; the limit is 1,000.`
    case 'TooManyStatements':
      return 'You’ve used all 5 statements for this lease.'
    case 'SummaryTooLong':
      return 'The ruling summary is over 1,000 bytes.'
    case 'NoOpenProposal':
      return `${leaseRef(args)} has no open AI proposal: ${NO_OPEN_PROPOSAL[Number(args[1])] ?? 'it is closed'}.`
    case 'ProposalLocked':
      return `The AI proposal on ${leaseRef(args).toLowerCase()} was appealed. Only the human arbiter can rule now.`
    case 'ChallengeWindowOver':
      return 'The challenge window is over, so the proposal can’t be appealed any more. Anyone can execute it now, and the human arbiter can still override it until then.'
    case 'ChallengeWindowOpen':
      return 'The challenge window hasn’t closed on-chain yet (Sepolia’s latest block can trail the clock by a few seconds). Try again shortly.'
    case 'InvalidChallengeWindow':
      return 'The challenge window must be between 1 minute and 30 days.'
    // LeaseShare1155
    case 'NotAllowlisted':
      return `${args[0] ? shortAddress(String(args[0])) : 'This address'} isn’t on the lease-share compliance allowlist, so it can’t hold lease shares.`
    case 'NotMinter':
      return 'The escrow isn’t allowed to mint lease shares yet (LeaseShare1155.setMinter).'
    case 'ERC1155InsufficientBalance':
      return 'You don’t hold that many shares of this lease.'
    case 'ERC1155InvalidReceiver':
      return 'The recipient contract can’t receive ERC-1155 tokens.'
    case 'ERC1155MissingApprovalForAll':
      return 'Only the share holder can move these shares.'
    // Token
    case 'ERC20InsufficientBalance':
      return 'Not enough of the escrow’s token in this wallet.'
    case 'ERC20InsufficientAllowance':
    case 'SafeERC20FailedOperation':
      return 'The token transfer failed. Check your balance and approve the escrow for the full amount.'
    default:
      return `The contract reverted with ${name}.`
  }
}

function tryDecode(data: Hex | undefined): { errorName: string; args: readonly unknown[] } | undefined {
  if (!data || data === '0x') return undefined
  try {
    const decoded = decodeErrorResult({ abi: knownErrorsAbi, data })
    return { errorName: decoded.errorName, args: decoded.args ?? [] }
  } catch {
    return undefined
  }
}

/** Turns anything thrown by viem / wagmi / the wallet into one sentence for the UI. */
export function errorMessage(error: unknown): string {
  // wagmi throws its own BaseError subclasses (e.g. ConnectorChainMismatchError), not viem's.
  if (error instanceof Error && /ChainMismatch|ChainNotConfigured/.test(error.name)) {
    return 'Switch MetaMask to Ethereum Sepolia and try again.'
  }
  if (!(error instanceof BaseError)) {
    const message = error instanceof Error ? (('shortMessage' in error && String(error.shortMessage)) || error.message) : String(error)
    return message
  }

  if (error.walk((e) => e instanceof UserRejectedRequestError)) return 'You rejected the request in your wallet.'

  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) {
    const decoded = reverted.data
      ? { errorName: reverted.data.errorName, args: reverted.data.args ?? [] }
      : tryDecode(reverted.raw)
    if (decoded && decoded.errorName !== 'Error' && decoded.errorName !== 'Panic') {
      return describeError(decoded.errorName, decoded.args)
    }
    if (reverted.reason) return `The contract reverted: ${reverted.reason}`
    return 'The contract reverted without a reason.'
  }

  if (error.walk((e) => e instanceof InsufficientFundsError)) {
    return 'Not enough Sepolia ETH for gas. Top up from a faucet and try again.'
  }
  return error.shortMessage || error.message
}
