import { describe, expect, it } from 'vitest'
import type { TransactionReceipt } from 'viem'
import { waitForReceipt } from '../hooks'

const hash = '0x7bf0421051633b4620397754eac004d033b725c3e3f544717c4c84bf1d66a266' as const
const receipt = { status: 'success', transactionHash: hash } as unknown as TransactionReceipt

describe('waitForReceipt', () => {
  it('keeps asking through nulls and errors until a backend has the receipt', async () => {
    const answers: (TransactionReceipt | null | Error)[] = [null, new Error('not found'), null, receipt]
    let calls = 0
    const client = {
      getTransactionReceipt: async () => {
        const a = answers[calls++]
        if (a instanceof Error) throw a
        return a as TransactionReceipt
      },
    }
    await expect(waitForReceipt(client as never, hash, 5_000, 1)).resolves.toBe(receipt)
    expect(calls).toBe(4)
  })

  it('gives up after the timeout with a readable message', async () => {
    const client = { getTransactionReceipt: async () => null }
    await expect(waitForReceipt(client as never, hash, 5, 1)).rejects.toThrow(/No receipt yet/)
  })
})
