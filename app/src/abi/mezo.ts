import { parseAbi } from 'viem'

/**
 * The slices of Mezo Borrow the app calls. Addresses are the Mezo testnet deployments from
 * mezo-org/musd (BorrowerOperations reports the price feed and sorted list itself; they are pinned
 * here so the first read doesn't have to wait for them).
 */
export const MEZO_BORROW = {
  borrowerOperations: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  sortedTroves: '0x722e4d24fd6ff8b0ac679450f3d91294607268fa',
  priceFeed: '0x86bcf0841622a5dac14a313a15f96a95421b9366',
  // Where a redeemed trove's leftover BTC waits until the owner calls claimCollateral().
  collSurplusPool: '0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9',
} as const

export const borrowerOperationsAbi = parseAbi([
  'function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable',
  'function withdrawMUSD(uint256 _amount, address _upperHint, address _lowerHint)',
  'function addColl(address _upperHint, address _lowerHint) payable',
  // repayMUSD burns the MUSD straight from the caller: no token approval is needed.
  'function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)',
  'function withdrawColl(uint256 _amount, address _upperHint, address _lowerHint)',
  'function closeTrove()',
  'function getBorrowingFee(uint256 _debt) view returns (uint256)',
  'function minNetDebt() view returns (uint256)',
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
  'function borrowingRate() view returns (uint256)',
  // Brings back any BTC the CollSurplusPool is holding for the caller (a redemption that closed the trove).
  'function claimCollateral()',
])

export const troveManagerAbi = parseAbi([
  'function getTroveStatus(address _borrower) view returns (uint8)',
  'function getEntireDebtAndColl(address _borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  // Signatures verified against mezo-org/musd solidity/contracts/interfaces/ITroveManager.sol.
  'function getCurrentICR(address _borrower, uint256 _price) view returns (uint256)',
  'function getTCR(uint256 _price) view returns (uint256)',
  'function checkRecoveryMode(uint256 _price) view returns (bool)',
  'function getTroveMaxBorrowingCapacity(address _borrower) view returns (uint256)',
  'function getTroveDebt(address _borrower) view returns (uint256)',
  // The redemption queue: every open trove's owner (the array only holds open troves), plus each one's
  // nominal ratio (the sorted-list order, coll / principal) for where a redemption would reach it next.
  'function getTroveOwnersCount() view returns (uint256)',
  'function getTroveFromTroveOwnersArray(uint256 _index) view returns (address)',
  'function getNominalICR(address _borrower) view returns (uint256)',
])

export const hintHelpersAbi = parseAbi([
  'function computeNominalCR(uint256 _coll, uint256 _debt) pure returns (uint256)',
  'function getApproxHint(uint256 _CR, uint256 _numTrials, uint256 _inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
])

export const sortedTrovesAbi = parseAbi([
  'function findInsertPosition(uint256 _NICR, address _prevId, address _nextId) view returns (address, address)',
])

export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)'])

export const collSurplusPoolAbi = parseAbi(['function getCollateral(address _account) view returns (uint256)'])

/**
 * Mezo's BorrowerOperationsSignatures (testnet 0xD757…639e): relays a tenant-signed EIP-712 trove
 * operation. Only the nonce read lives here — the app signs the messages itself (lib/mezoSignatures)
 * and RentEscrowV2 relays the operation in borrowAndFund / withdrawAndFund.
 */
export const borrowerOperationsSignaturesAbi = parseAbi(['function getNonce(address user) view returns (uint256)'])
