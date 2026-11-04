import { describe, expect, it } from 'vitest'
import { concat, encodeAbiParameters, hashTypedData, keccak256, toHex, type Address } from 'viem'
import { MEZO_CHAIN_ID } from '../network'
import { mezoSignaturesDomain, openTroveTypes, withdrawMusdTypes } from './mezoSignatures'

// The signatures contract on Mezo testnet.
const signatures = '0xD757e3646AF370b15f32EB557F0F8380Df7D639e' as Address
const escrow = '0xdD4A5747d336Bb6653a5430d87CdaAc89dd9113e' as Address
const tenant = '0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1' as Address

/**
 * The digest built exactly the way the on-chain verifier does (test/helpers/MezoSignatures.sol):
 * keccak256(0x19 0x01 ‖ domainSeparator ‖ keccak256(abi.encode(typeHash, …values))). Both hashes and
 * the typehash strings are spelled out here independently of the helper, so a renamed field, a
 * reordered field or a wrong domain fails this test.
 */
function onChainDigest(typehashSource: string, values: readonly [bigint, bigint, Address, Address, bigint, bigint] | readonly [bigint, Address, Address, bigint, bigint]): `0x${string}` {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toHex('BorrowerOperationsSignatures')),
        keccak256(toHex('1')),
        BigInt(MEZO_CHAIN_ID),
        signatures,
      ],
    ),
  )
  const fields = (values.map((value) => ({ type: typeof value === 'bigint' ? 'uint256' : 'address' })) as { type: string }[])
  const structHash = keccak256(concat([keccak256(toHex(typehashSource)), encodeAbiParameters(fields, values as unknown as readonly bigint[])]))
  return keccak256(concat(['0x1901', domainSeparator, structHash]))
}

describe('Mezo BorrowerOperationsSignatures typed data', () => {
  it('hashes OpenTrove to the on-chain digest (assetAmount, debtAmount, borrower, recipient, nonce, deadline)', () => {
    const assetAmount = 52_240_000_000_000_000n // 0.05224 BTC of collateral
    const debtAmount = 2_000n * 10n ** 18n
    const nonce = 0n
    const deadline = 1_762_300_000n
    const digest = hashTypedData({
      domain: mezoSignaturesDomain(signatures),
      types: openTroveTypes,
      primaryType: 'OpenTrove',
      message: { assetAmount, debtAmount, borrower: tenant, recipient: escrow, nonce, deadline },
    })
    expect(digest).toBe(
      onChainDigest(
        'OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)',
        [assetAmount, debtAmount, tenant, escrow, nonce, deadline],
      ),
    )
  })

  it('hashes WithdrawMUSD to the on-chain digest (amount, borrower, recipient, nonce, deadline)', () => {
    const amount = 250n * 10n ** 18n
    const nonce = 3n
    const deadline = 1_762_300_000n
    const digest = hashTypedData({
      domain: mezoSignaturesDomain(signatures),
      types: withdrawMusdTypes,
      primaryType: 'WithdrawMUSD',
      message: { amount, borrower: tenant, recipient: escrow, nonce, deadline },
    })
    expect(digest).toBe(
      onChainDigest('WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,uint256 deadline)', [
        amount,
        tenant,
        escrow,
        nonce,
        deadline,
      ]),
    )
  })
})
