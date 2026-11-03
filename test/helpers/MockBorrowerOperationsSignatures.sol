// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice TEST-ONLY stand-in for Mezo's BorrowerOperationsSignatures (same name, so tests build
///         signatures through test/helpers/MezoSignatures.sol exactly as they will for the real
///         contract). Verifies real EIP-712 signatures over the same typehashes and domain shape
///         (name "BorrowerOperationsSignatures", version "1", chainId, this contract), enforces the
///         same expiry (deadline is inclusive) and nonce rules, then mints the mock MUSD to the
///         recipient — exactly the requested amount, like the real protocol, whose 0.1% borrowing
///         fee goes to the PCV and whose 200 MUSD gas reserve goes to the gas pool, neither out of
///         the recipient's transfer.
interface MintableMUSD {
    function mint(address to, uint256 amount) external;
}

contract MockBorrowerOperationsSignatures is EIP712 {
    bytes32 public constant OPEN_TROVE_TYPEHASH = keccak256(
        "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW_MUSD_TYPEHASH =
        keccak256("WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,uint256 deadline)");

    MintableMUSD public immutable musd;
    mapping(address => uint256) private _nonces;

    /// @dev The last call's parameters, for assertions.
    address public lastCaller;
    address public lastBorrower;
    address public lastRecipient;
    uint256 public lastAssetAmount; // BTC collateral attached to openTroveWithSignature
    uint256 public lastDebtAmount; // debtAmount / amount of the last call
    bool public troveOpened; // true once openTroveWithSignature succeeded
    bool public musdWithdrawn; // true once withdrawMUSDWithSignature succeeded

    event MockTroveOpened(address indexed borrower, address indexed recipient, uint256 debt, uint256 collateral);
    event MockMUSDWithdrawn(address indexed borrower, address indexed recipient, uint256 amount);

    constructor(MintableMUSD musd_) EIP712("BorrowerOperationsSignatures", "1") {
        musd = musd_;
    }

    function openTroveWithSignature(
        uint256 debtAmount,
        address, /* upperHint */
        address, /* lowerHint */
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable {
        _verify(
            OPEN_TROVE_TYPEHASH, abi.encode(msg.value, debtAmount, borrower, recipient), borrower, signature, deadline
        );
        (lastCaller, lastBorrower, lastRecipient, lastAssetAmount, lastDebtAmount) =
        (msg.sender, borrower, recipient, msg.value, debtAmount);
        troveOpened = true;
        musd.mint(recipient, debtAmount);
        emit MockTroveOpened(borrower, recipient, debtAmount, msg.value);
    }

    function withdrawMUSDWithSignature(
        uint256 amount,
        address, /* upperHint */
        address, /* lowerHint */
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external {
        _verify(WITHDRAW_MUSD_TYPEHASH, abi.encode(amount, borrower, recipient), borrower, signature, deadline);
        // Faithful to the real protocol's MUSD-withdraw path (discovered on the testnet fork):
        // Mezo always pays the caller its collateral delta through ActivePool.sendCollateral — a
        // BTC transfer even when the delta is zero, which is the only value it can be here.
        // RentEscrowV2.receive exists for exactly this zero-value touch.
        (bool ok,) = msg.sender.call{value: 0}("");
        require(ok, "Sending BTC failed");
        (lastCaller, lastBorrower, lastRecipient, lastDebtAmount) = (msg.sender, borrower, recipient, amount);
        musdWithdrawn = true;
        musd.mint(recipient, amount);
        emit MockMUSDWithdrawn(borrower, recipient, amount);
    }

    function getNonce(address user) external view returns (uint256) {
        return _nonces[user];
    }

    /// @dev Mirrors Mezo's _verifySignature: inclusive deadline, digest packs typeHash ++ encoded
    ///      struct fields ++ nonce ++ deadline, recovered signer must be the borrower, then the
    ///      nonce increments (so a signature is single-use).
    function _verify(bytes32 typeHash, bytes memory data, address borrower, bytes calldata signature, uint256 deadline)
        internal
    {
        require(block.timestamp <= deadline, "Signature expired");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encodePacked(typeHash, data, _nonces[borrower], deadline)));
        address recovered = ECDSA.recover(digest, signature);
        require(recovered == borrower, "BorrowerOperationsSignatures: Invalid signature");
        _nonces[borrower]++;
    }
}
