// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {IRentEscrowV2} from "../src/interfaces/IRentEscrowV2.sol";
import {MezoSignatures} from "./helpers/MezoSignatures.sol";

/// @dev Read-only views of the live Mezo protocol (mezo-org/musd), as tiny as the test needs them.
interface IMezoDomain {
    /// @dev ERC-5267; BorrowerOperationsSignatures is an EIP712Upgradeable.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
    function getNonce(address user) external view returns (uint256);
}

interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

interface IBorrowerOpsConstants {
    function minNetDebt() external view returns (uint256);
    function borrowingRate() external view returns (uint256);
}

interface IHintHelpers {
    function computeNominalCR(uint256 coll, uint256 debt) external pure returns (uint256);
    function getApproxHint(uint256 CR, uint256 numTrials, uint256 inputRandomSeed)
        external
        view
        returns (address hint, uint256 diff, uint256 latestRandomSeed);
}

interface ISortedTroves {
    function findInsertPosition(uint256 NICR, address prevId, address nextId) external view returns (address, address);
}

interface ITroveManager {
    function getTroveStatus(address borrower) external view returns (uint8);
    function getTroveColl(address borrower) external view returns (uint256);
    function getTroveDebt(address borrower) external view returns (uint256);
}

/// @dev Mezo serves the BTC/USD aggregator at a chain-id-derived SYSTEM address (0x7b7c = 31611).
///      That contract is native to the Mezo node: under revm — a foundry fork — its staticcall
///      burns ~280k gas and reverts with no data, so PriceFeed.fetchPrice (and with it every trove
///      operation) cannot execute on a plain fork. The fork test pins that one address to a stub
///      replaying exactly the round the real aggregator served at FORK_BLOCK (verified with cast
///      against the pinned block); every other contract — PriceFeed included — stays real.
contract MezoSystemOracleStub {
    /// @dev The round the real aggregator served at FORK_BLOCK (read via cast at that block).
    uint80 internal constant ROUND_ID = 15_443_847;
    int256 internal constant ANSWER = 76_653_162_640_000_000_000_000; // BTC/USD, 18 decimals

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = ROUND_ID;
        answer = ANSWER;
        startedAt = block.timestamp; // the real round was this fresh; stay fresh across warps
        updatedAt = block.timestamp;
        answeredInRound = 0; // exactly what the real aggregator reported
    }
}

/// @notice RentEscrowV2 against the real Mezo testnet, forked at a pinned block: a fresh EOA signs
///         a real OpenTrove EIP-712 message, and one borrowAndFund call opens the tenant's trove
///         and funds the lease in a single transaction. Pinned so the run is reproducible; skips
///         itself when the public RPC (load-balanced, occasionally flaky) cannot be reached.
contract RentEscrowV2ForkTest is Test {
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant BORROWER_OPS_SIGNATURES = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address internal constant BORROWER_OPS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address internal constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address internal constant HINT_HELPERS = 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6;
    address internal constant SORTED_TROVES = 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA;
    address internal constant PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    /// @dev The system BTC/USD aggregator (see MezoSystemOracleStub for why it is pinned).
    address internal constant SYSTEM_ORACLE = 0x7b7c000000000000000000000000000000000015;

    /// @dev Mezo testnet chain id (0x7b7b).
    uint256 internal constant MEZO_CHAIN_ID = 31611;
    /// @dev A recent block at which the BTC/USD oracle answer was fresh (fetchPrice's 60 s window).
    ///      2026-11-02: BTC ~ $76.6k, min net debt 1800 MUSD, 356 troves in the sorted list.
    uint256 internal constant FORK_BLOCK = 16_538_943;

    /// @dev Mezo's 200 MUSD gas reserve, added to the trove's debt (never out of the recipient).
    uint256 internal constant MUSD_GAS_COMPENSATION = 200e18;

    address internal landlord = makeAddr("landlord");
    address internal arbiter = makeAddr("arbiter");

    /// @dev A tenant EOA that has never touched the chain: vm.addr of a fixed test key.
    uint256 internal constant TENANT_KEY = 0xF072;
    address internal tenant;

    RentEscrowV2 internal escrow;

    /// @dev A lease the demo can afford from one trove: 500 MUSD deposit + 6 x 125 MUSD rent.
    uint128 internal constant DEPOSIT = 500e18;
    uint128 internal constant RENT = 125e18;
    uint32 internal constant PERIOD = 1 days;
    uint16 internal constant PERIODS = 6;
    uint256 internal constant OWED = uint256(DEPOSIT) + uint256(RENT) * PERIODS; // 1250e18

    /// @dev Mezo's minimum trove is 1800 MUSD net: borrow 2000, keep the 750 surplus coming back.
    uint256 internal constant DEBT = 2_000e18;

    function setUp() public {
        tenant = vm.addr(TENANT_KEY);
        // The public endpoint is load-balanced and occasionally flaky: skip the suite rather than
        // fail when it cannot be reached.
        try vm.createSelectFork("mezo_testnet", FORK_BLOCK) returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }

        escrow = new RentEscrowV2(IERC20(MUSD), arbiter, address(0), address(0), BORROWER_OPS_SIGNATURES, 30 days);
        vm.deal(tenant, 1 ether); // BTC collateral + gas
        // See MezoSystemOracleStub: the node-native aggregator cannot run under revm, so the fork
        // replays its FORK_BLOCK round. Everything else on the fork is the real testnet state.
        vm.etch(SYSTEM_ORACLE, address(new MezoSystemOracleStub()).code);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev approx hints: NICR on the composite debt (debt + ~fee + gas reserve), then the sorted
    ///      list's own insert position around the random probe.
    function _openHints(uint256 collateral, uint256 compositeDebt)
        internal
        view
        returns (address upper, address lower)
    {
        uint256 nicr = IHintHelpers(HINT_HELPERS).computeNominalCR(collateral, compositeDebt);
        (address approx,,) = IHintHelpers(HINT_HELPERS).getApproxHint(nicr, 15, 42);
        (upper, lower) = ISortedTroves(SORTED_TROVES).findInsertPosition(nicr, approx, approx);
    }

    function _openSig(uint256 assetAmount, uint256 deadline) internal view returns (bytes memory) {
        return MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.openTroveDigest(
                BORROWER_OPS_SIGNATURES,
                assetAmount,
                DEBT,
                tenant,
                address(escrow),
                IMezoDomain(BORROWER_OPS_SIGNATURES).getNonce(tenant),
                deadline
            )
        );
    }

    function _withdrawSig(uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.withdrawMUSDDigest(
                BORROWER_OPS_SIGNATURES,
                amount,
                tenant,
                address(escrow),
                IMezoDomain(BORROWER_OPS_SIGNATURES).getNonce(tenant),
                deadline
            )
        );
    }

    // ------------------------------------------------------------------ the protocol itself

    /// @dev The EIP-712 domain the escrow's signatures are checked against, read from the chain
    ///      (ERC-5267) rather than assumed: the fork test only means anything if this passes.
    function test_MezoDomainMatchesTheExpectedShape() public {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IMezoDomain(BORROWER_OPS_SIGNATURES).eip712Domain();

        assertEq(name, "BorrowerOperationsSignatures");
        assertEq(version, "1");
        assertEq(chainId, MEZO_CHAIN_ID);
        assertEq(verifying, BORROWER_OPS_SIGNATURES);
        assertEq(uint8(fields), 0x0f); // name | version | chainId | verifyingContract

        console2.log("EIP-712 domain:", name, version);
        console2.log("chainId:", chainId);
        console2.log("verifyingContract:", verifying);
        assertEq(IMezoDomain(BORROWER_OPS_SIGNATURES).getNonce(tenant), 0, "fresh tenant");
    }

    /// @dev One transaction: the tenant's signature opens their own trove (BTC collateral in the
    ///      same call) and the minted MUSD lands on the escrow, which books the lease and refunds
    ///      the surplus. Records whether debtAmount is exactly what the recipient received.
    function test_Fork_BorrowAndFund_OpensTroveAndFundsLeaseInOneTx() public {
        uint256 price = IPriceFeed(PRICE_FEED).fetchPrice();
        uint256 fee = DEBT * IBorrowerOpsConstants(BORROWER_OPS).borrowingRate() / 1e18; // 0.1%
        uint256 compositeDebt = DEBT + fee + MUSD_GAS_COMPENSATION;
        // 300% ICR: comfortably above MCR (110%) and above CCR (150%) even in recovery mode.
        uint256 collateral = compositeDebt * 3e18 / price;
        (address upper, address lower) = _openHints(collateral, compositeDebt);
        uint256 deadline = block.timestamp + 1 hours;

        assertEq(IBorrowerOpsConstants(BORROWER_OPS).minNetDebt(), 1800e18, "min net debt changed");

        vm.prank(landlord);
        uint256 leaseId = escrow.createLease(tenant, DEPOSIT, RENT, PERIOD, PERIODS);

        // Sign before the prank: _openSig reads the nonce from the fork, and any external call
        // between vm.prank and the pranked call (argument evaluation included) consumes the prank.
        bytes memory sig = _openSig(collateral, deadline);
        uint256 escrowMusdBefore = IERC20(MUSD).balanceOf(address(escrow));
        vm.prank(tenant);
        escrow.borrowAndFund{value: collateral}(leaseId, DEBT, upper, lower, sig, deadline);

        // The trove belongs to the tenant and holds the forwarded BTC.
        assertEq(ITroveManager(TROVE_MANAGER).getTroveStatus(tenant), 1, "trove not active"); // Status.active
        assertEq(ITroveManager(TROVE_MANAGER).getTroveColl(tenant), collateral, "collateral not forwarded");
        assertEq(ITroveManager(TROVE_MANAGER).getTroveDebt(tenant), compositeDebt, "trove debt mismatch");
        assertEq(address(escrow).balance, 0, "escrow must not hold BTC");
        assertEq(IMezoDomain(BORROWER_OPS_SIGNATURES).getNonce(tenant), 1, "nonce consumed");

        // The lease is funded with exactly what the terms require.
        IRentEscrowV2.Lease memory l = escrow.getLease(leaseId);
        assertEq(uint8(l.state), uint8(IRentEscrowV2.State.ACTIVE));
        assertEq(escrow.escrowBalance(leaseId), OWED, "escrow must hold exactly owed");
        assertEq(IERC20(MUSD).balanceOf(address(escrow)) - escrowMusdBefore, OWED);
        assertEq(escrow.tenantStats(tenant).leasesFunded, 1);

        // Did debtAmount equal what the recipient received? The surplus refund answers: the tenant
        // started with no MUSD, so its whole balance is the refund of received - owed.
        uint256 received = OWED + IERC20(MUSD).balanceOf(tenant);
        uint256 refund = IERC20(MUSD).balanceOf(tenant);
        console2.log("debtAmount       :", DEBT);
        console2.log("received by escrow+refund:", received);
        console2.log("surplus refund   :", refund);
        assertEq(received, DEBT, "recipient did not receive exactly debtAmount");
        assertEq(refund, DEBT - OWED, "surplus not refunded to the tenant");
    }

    /// @dev The second funding path against the real protocol: more MUSD minted against the now
    ///      open trove (WithdrawMUSD signature), funding a second lease in one call.
    function test_Fork_WithdrawAndFund_MintsAgainstTheOpenTrove() public {
        // Open a trove first (same shape as the borrowAndFund test).
        uint256 price = IPriceFeed(PRICE_FEED).fetchPrice();
        uint256 fee = DEBT * IBorrowerOpsConstants(BORROWER_OPS).borrowingRate() / 1e18;
        uint256 compositeDebt = DEBT + fee + MUSD_GAS_COMPENSATION;
        uint256 collateral = compositeDebt * 3e18 / price;
        (address upper, address lower) = _openHints(collateral, compositeDebt);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign before the prank (see test_Fork_BorrowAndFund_...): the sig helpers read the nonce
        // from the fork and would consume it.
        bytes memory openSig = _openSig(collateral, deadline);
        vm.prank(landlord);
        uint256 firstLease = escrow.createLease(tenant, DEPOSIT, RENT, PERIOD, PERIODS);
        vm.prank(tenant);
        escrow.borrowAndFund{value: collateral}(firstLease, DEBT, upper, lower, openSig, deadline);
        assertEq(ITroveManager(TROVE_MANAGER).getTroveStatus(tenant), 1);

        bytes memory withdrawSig = _withdrawSig(DEBT, deadline);
        vm.prank(landlord);
        uint256 secondLease = escrow.createLease(tenant, DEPOSIT, RENT, PERIOD, PERIODS);
        vm.prank(tenant);
        escrow.withdrawAndFund(secondLease, DEBT, upper, lower, withdrawSig, deadline);

        assertEq(uint8(escrow.getLease(secondLease).state), uint8(IRentEscrowV2.State.ACTIVE));
        assertEq(escrow.escrowBalance(secondLease), OWED);
        assertEq(IERC20(MUSD).balanceOf(address(escrow)), 2 * OWED, "surplus of the second fund refunded");
        assertEq(IMezoDomain(BORROWER_OPS_SIGNATURES).getNonce(tenant), 2, "both signatures consumed");
    }
}
