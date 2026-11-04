import { describe, expect, it } from 'vitest'

/** Every UI source file, as text. */
const sources = import.meta.glob<string>('./**/*.tsx', { query: '?raw', import: 'default', eager: true })

describe('UI copy', () => {
  it('never names the judge model: nothing the page reads on-chain records which model proposed a ruling', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    for (const [file, text] of Object.entries(sources)) expect(text, file).not.toMatch(/\bGLM\b/i)
  })

  it('explains jargon instead of naming it: collateral-ratio acronyms (ICR/TCR/NICR) never appear in copy', () => {
    // A quoted string carrying the acronym would show it to the user; code identifiers and comments may.
    const quotedAcronym = /(['"`])[^'"`]*\b(?:ICR|TCR|NICR)\b[^'"`]*\1/
    for (const [file, text] of Object.entries(sources)) expect(text, file).not.toMatch(quotedAcronym)
  })
})
