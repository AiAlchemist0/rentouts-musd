import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  zeroAddress,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { aiArbiterAbi } from '../abi/aiArbiter'
import { leaseShareAbi } from '../abi/leaseShare'
import { rentEscrowAbi } from '../abi/rentEscrow'
import { rentEscrowV2Abi } from '../abi/rentEscrowV2'
import { rentoutsSubnamesAbi } from '../abi/rentoutsSubnames'
import { describeError, errorMessage } from './errors'

const alice = '0x484811c8c967809bE644A89d677933c29fb9e936'

/** What simulateContract throws when `abi` is the ABI of the contract that was called. */
function revert(
  abi: typeof rentEscrowAbi | typeof rentoutsSubnamesAbi | typeof aiArbiterAbi | typeof rentEscrowV2Abi,
  functionName: string,
  data: `0x${string}`,
) {
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName }), {
    abi,
    functionName,
    args: [],
    contractAddress: zeroAddress,
  })
}

describe('describeError', () => {
  it('maps the claim-flow errors', () => {
    expect(describeError('LabelTaken', ['alice'])).toMatch(/taken/)
    expect(describeError('AlreadyHasName', [alice])).toMatch(/already holds/)
    expect(describeError('LabelRetired', ['bob'])).toMatch(/retired/)
    expect(describeError('InvalidLabel', ['-x'])).toMatch(/3–32/)
    expect(describeError('NotAuthorized')).toMatch(/connected wallet/)
  })

  it('names the lease state for InvalidState', () => {
    expect(describeError('InvalidState', [7n, 4])).toBe('Lease #7 is closed, so this action isn’t available.')
  })

  it('mentions the party rules for InvalidTerms', () => {
    expect(describeError('InvalidTerms')).toMatch(/arbiter can’t be the landlord or the tenant/)
  })

  it('explains the human gate for NotVerifiedHuman', () => {
    expect(describeError('NotVerifiedHuman', [alice])).toBe(
      '0x4848…e936 hasn’t passed the escrow’s human verification (World ID 4.0: not registered in the gate), so it can’t fund a lease.',
    )
    expect(describeError('NotVerifiedHuman')).toMatch(/^This wallet hasn’t passed/)
  })

  it('explains the AI judge’s rules', () => {
    expect(describeError('NoOpenProposal', [3n, 2])).toBe('Lease #3 has no open AI proposal: it was appealed, so only the human arbiter can rule now.')
    expect(describeError('NoOpenProposal', [3n, 0])).toMatch(/hasn’t proposed a ruling yet/)
    expect(describeError('NotDisputed', [3n, 4])).toBe('Lease #3 is closed, not in dispute.')
    expect(describeError('PartyCannotArbitrate', [3n, alice])).toBe('0x4848…e936 is a party to lease #3, so it can’t rule on it.')
    expect(describeError('InvalidStatementLength', [0n])).toBe('Write a statement first.')
    expect(describeError('InvalidStatementLength', [1200n])).toMatch(/1,200 bytes/)
    expect(describeError('ChallengeWindowOver', [3n, 1n])).toMatch(/can’t be appealed any more/)
    expect(describeError('ChallengeWindowOpen', [3n, 1n])).toMatch(/hasn’t closed on-chain yet/)
    expect(describeError('NotHuman')).toBe('Only the human arbiter can do this.')
    expect(describeError('NotParty', [3n])).toBe('Only the landlord or the tenant of lease #3 can do this.')
  })

  it('falls back to the error name', () => {
    expect(describeError('SomethingNew')).toBe('The contract reverted with SomethingNew.')
  })

  it('maps the Wave-2 escrow’s funding errors', () => {
    expect(describeError('MezoDisabled')).toMatch(/can’t relay Mezo trove operations/)
    expect(describeError('StrayBtc', [123n])).toMatch(/only ever holds MUSD/)
    expect(describeError('InsufficientBorrowed', [3n, 1_250n * 10n ** 18n, 1_800n * 10n ** 18n])).toBe(
      'The trove operation sent the escrow 1,250.00 of the 1,800.00 the lease needs, so the lease wasn’t funded. The Mezo permission may already have been used elsewhere; sign again, or pay with MUSD you already have.',
    )
    // Without decodable amounts the sentence still stands alone.
    expect(describeError('InsufficientBorrowed', [3n])).toMatch(/^The trove operation sent the escrow less MUSD/)
  })

  it('maps the early-termination errors', () => {
    expect(describeError('NoProposal', [3n])).toBe('Lease #3 has no open early-end offer (never made, or already withdrawn, replaced or accepted).')
    expect(describeError('NotProposer', [3n])).toMatch(/Only the wallet that made this early-end offer/)
    expect(describeError('ProposalExpired', [3n])).toMatch(/expired before it was accepted/)
    expect(describeError('WrongTermsHash', [3n])).toMatch(/The offer changed on-chain/)
    expect(describeError('ProposerCannotAccept', [3n])).toMatch(/The other side must accept/)
    expect(describeError('InvalidExpiry', [3n, 1n])).toMatch(/expiry must be in the future/)
    expect(describeError('PenaltyTooHigh', [3n, 100n * 10n ** 18n, 60n * 10n ** 18n])).toBe(
      'The penalty is more than the tenant’s side (unearned rent + deposit), which is 60.00 MUSD now. Lower it and try again.',
    )
    expect(describeError('PenaltyTooHigh', [3n])).toMatch(/more than the tenant’s side/)
  })

  it('maps the dispute-timeout and unbooked-pot errors', () => {
    expect(describeError('DisputeNotTimedOut', [3n])).toMatch(/timeout hasn’t passed/)
    expect(describeError('InsufficientUnbooked', [100n, 50n])).toMatch(/unbooked pot/)
  })
})

describe('errorMessage', () => {
  it('decodes a custom error on the called contract’s ABI', () => {
    const data = encodeErrorResult({ abi: rentoutsSubnamesAbi, errorName: 'LabelTaken', args: ['alice'] })
    expect(errorMessage(revert(rentoutsSubnamesAbi, 'register', data))).toBe('This name is taken. Pick another one.')
  })

  it('decodes an error bubbled up from another contract (LeaseShare1155 via the escrow)', () => {
    const data = encodeErrorResult({ abi: leaseShareAbi, errorName: 'NotAllowlisted', args: [alice] })
    expect(errorMessage(revert(rentEscrowAbi, 'createLease', data))).toMatch(/^0x4848…e936 isn’t on the lease-share compliance allowlist/)
  })

  it('decodes Wave-2 reverts from borrowAndFund, including on an ABI that doesn’t list them', () => {
    const data = encodeErrorResult({ abi: rentEscrowV2Abi, errorName: 'InsufficientBorrowed', args: [3n, 0n, 1_800n * 10n ** 18n] })
    expect(errorMessage(revert(rentEscrowV2Abi, 'borrowAndFund', data))).toMatch(/of the 1,800\.00 the lease needs/)
    // Decoded against knownErrorsAbi even when the called contract's ABI has no Wave-2 errors.
    expect(errorMessage(revert(rentoutsSubnamesAbi, 'register', data))).toMatch(/trove operation sent the escrow/)
    const penalty = encodeErrorResult({ abi: rentEscrowV2Abi, errorName: 'PenaltyTooHigh', args: [3n, 100n, 60n] })
    expect(errorMessage(revert(rentEscrowV2Abi, 'proposeTermination', penalty))).toMatch(/tenant’s side/)
  })

  it('decodes a NotVerifiedHuman revert from fundLease', () => {
    const data = encodeErrorResult({ abi: rentEscrowAbi, errorName: 'NotVerifiedHuman', args: [alice] })
    expect(errorMessage(revert(rentEscrowAbi, 'fundLease', data))).toMatch(/^0x4848…e936 hasn’t passed the escrow’s human verification/)
    // Also when the revert surfaces through a call whose ABI doesn't list it (decoded against knownErrorsAbi).
    expect(errorMessage(revert(rentoutsSubnamesAbi, 'register', data))).toMatch(/World ID 4\.0/)
  })

  it('decodes AIArbiter reverts, including the escrow’s bubbling through it', () => {
    const data = encodeErrorResult({ abi: aiArbiterAbi, errorName: 'TooManyStatements', args: [3n, alice] })
    expect(errorMessage(revert(aiArbiterAbi, 'submitEvidence', data))).toBe('You’ve used all 5 statements for this lease.')
    const escrowData = encodeErrorResult({ abi: rentEscrowAbi, errorName: 'InvalidState', args: [3n, 4] })
    expect(errorMessage(revert(aiArbiterAbi, 'execute', escrowData))).toBe('Lease #3 is closed, so this action isn’t available.')
  })

  it('passes through require() reasons', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['ERC20: transfer amount exceeds balance'],
    })
    expect(errorMessage(revert(rentEscrowAbi, 'fundLease', data))).toBe(
      'The contract reverted: ERC20: transfer amount exceeds balance',
    )
  })

  it('recognizes a wallet rejection', () => {
    expect(errorMessage(new UserRejectedRequestError(new Error('User denied')))).toBe(
      'You rejected the request in your wallet.',
    )
  })

  it('handles plain errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })
})
