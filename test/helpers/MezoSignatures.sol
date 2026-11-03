// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @title MezoSignatures
/// @notice Builds the EIP-712 digests (and signatures) for Mezo's BorrowerOperationsSignatures
///         trove operations, exactly the way the on-chain contract verifies them: domain
///         { name: "BorrowerOperationsSignatures", version: "1", chainId, verifyingContract } and
///         the OpenTrove / WithdrawMUSD typehashes from solidity/contracts/BorrowerOperationsSignatures.sol
///         (mezo-org/musd). Used by the unit tests (against the mock), the invariant handler and the
///         Mezo fork test (against the real testnet contract).
library MezoSignatures {
    /// @dev The fixed foundry cheatcode address (the `vm` of the running test).
    Vm internal constant vm = Vm(address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D));

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant OPEN_TROVE_TYPEHASH = keccak256(
        "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant WITHDRAW_MUSD_TYPEHASH =
        keccak256("WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,uint256 deadline)");

    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("BorrowerOperationsSignatures")),
                keccak256(bytes("1")),
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @dev Digest for OpenTrove: assetAmount is the BTC collateral (msg.value) attached to the call.
    function openTroveDigest(
        address verifyingContract,
        uint256 assetAmount,
        uint256 debtAmount,
        address borrower,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(verifyingContract),
                keccak256(
                    abi.encode(OPEN_TROVE_TYPEHASH, assetAmount, debtAmount, borrower, recipient, nonce, deadline)
                )
            )
        );
    }

    function withdrawMUSDDigest(
        address verifyingContract,
        uint256 amount,
        address borrower,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(verifyingContract),
                keccak256(abi.encode(WITHDRAW_MUSD_TYPEHASH, amount, borrower, recipient, nonce, deadline))
            )
        );
    }

    function sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
