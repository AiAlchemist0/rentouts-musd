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
} as const

export const borrowerOperationsAbi = parseAbi([
  'function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable',
  'function withdrawMUSD(uint256 _amount, address _upperHint, address _lowerHint)',
  'function addColl(address _upperHint, address _lowerHint) payable',
  'function getBorrowingFee(uint256 _debt) view returns (uint256)',
  'function minNetDebt() view returns (uint256)',
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
  'function borrowingRate() view returns (uint256)',
])

export const troveManagerAbi = parseAbi([
  'function getTroveStatus(address _borrower) view returns (uint8)',
  'function getEntireDebtAndColl(address _borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
])

export const hintHelpersAbi = parseAbi([
  'function computeNominalCR(uint256 _coll, uint256 _debt) pure returns (uint256)',
  'function getApproxHint(uint256 _CR, uint256 _numTrials, uint256 _inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
])

export const sortedTrovesAbi = parseAbi([
  'function findInsertPosition(uint256 _NICR, address _prevId, address _nextId) view returns (address, address)',
])

export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)'])
