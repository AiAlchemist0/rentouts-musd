// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMezoBorrowerOperationsSignatures
/// @notice The two Mezo Borrow trove operations RentEscrowV2 relays for a tenant, plus the nonce
///         lookup needed to build their EIP-712 signatures. Mezo's BorrowerOperationsSignatures
///         (mezo-org/musd, solidity/contracts/BorrowerOperationsSignatures.sol; Mezo testnet
///         0xd757e3646af370b15f32eb557f0f8380df7d639e) lets any contract run a trove operation for
///         a borrower who signed an EIP-712 message; the MUSD is minted to `recipient`.
///
///         The signed messages (domain: name "BorrowerOperationsSignatures", version "1", chainId,
///         the BorrowerOperationsSignatures address itself):
///           OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,
///                     uint256 nonce,uint256 deadline)
///           WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,
///                        uint256 deadline)
///         where assetAmount is the BTC collateral attached to the call (msg.value). The recipient
///         receives exactly debtAmount / amount: Mezo's 0.1% borrowing fee is minted to the PCV and
///         its 200 MUSD gas reserve to the gas pool, on top of the trove's debt, never out of the
///         recipient's transfer.
interface IMezoBorrowerOperationsSignatures {
    /// @notice Opens a trove for `borrower` with `debtAmount` MUSD of net new debt, BTC collateral
    ///         = msg.value, sending the minted MUSD to `recipient`. Payable (the value is the
    ///         collateral and is covered by the signature's assetAmount field).
    function openTroveWithSignature(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    /// @notice Mints `amount` of new MUSD against `borrower`'s existing trove and sends it to
    ///         `recipient` (a debt-increasing trove adjustment under the hood).
    function withdrawMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external;

    /// @notice The borrower's signature nonce; every used signature increments it.
    function getNonce(address user) external view returns (uint256);
}
