// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployEscrowV2, GateChoiceV2} from "../script/DeployEscrowV2.s.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";

/// @dev DeployEscrowV2 only checks that ESCROW_V2_SIGNATURES has code; any contract stands in.
contract MockBorrowerOperationsSignaturesShim {
    function getNonce(address) external pure returns (uint256) {
        return 0;
    }
}

/// @notice script/DeployEscrowV2.s.sol on a local chain that reports Mezo testnet's chain id: the
///         config checks, and that the deployed system is wired the way the README describes.
contract DeployEscrowV2Test is Test {
    DeployEscrowV2 internal script;
    MockUSDC internal musd;
    MockBorrowerOperationsSignaturesShim internal signatures; // a contract, so the code check passes

    address internal deployer = makeAddr("deployer"); // also the demo landlord
    address internal arbiter = makeAddr("arbiter");
    address internal tenant = makeAddr("tenant");

    uint64 internal constant TIMEOUT = 14 days;

    string internal constant SCRATCH_DIR = "./cache/deploy-escrow-test";
    // one scratch file per test: forge runs tests in parallel
    string internal constant UPSERT_FILE = "./cache/deploy-escrow-test/upsert-v2.json";
    string internal constant MISSING_FILE = "./cache/deploy-escrow-test/missing-v2.json";

    function setUp() public {
        vm.chainId(31611); // Mezo testnet: the V2 script deploys nowhere else
        script = new DeployEscrowV2();
        musd = new MockUSDC();
        signatures = new MockBorrowerOperationsSignaturesShim();
    }

    /// @dev The default deploy: a new open HumanGate, a new LeaseShare1155, the Mezo relay on.
    function _deploy(address signatures_, uint64 timeout_)
        internal
        returns (RentEscrowV2 escrow, LeaseShare1155 shares, address gate)
    {
        (escrow, shares, gate) = script.deploy(
            deployer, address(musd), arbiter, address(0), GateChoiceV2.DeployNew, address(0), signatures_, timeout_
        );
    }

    // ------------------------------------------------------------------ wiring

    function test_Deploy_WiresV2WithSignatureRelayAndTimeout() public {
        (RentEscrowV2 escrow, LeaseShare1155 shares, address gate) = _deploy(address(signatures), TIMEOUT);

        assertEq(escrow.token(), address(musd));
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.leaseShare(), address(shares));
        assertEq(shares.owner(), deployer);
        assertEq(shares.minter(), address(escrow));
        assertTrue(shares.allowlisted(deployer));
        assertEq(escrow.humanGate(), gate);
        assertEq(escrow.borrowerOpsSignatures(), address(signatures));
        assertEq(escrow.disputeTimeout(), TIMEOUT);

        // The demo flow still works on V2: the demo landlord lists, the lease ids start at 1.
        vm.prank(deployer);
        uint256 id = escrow.createLease(tenant, 300_000e6, 100_000e6, 60, 3);
        assertEq(id, 1);
    }

    function test_Deploy_SignaturesNone_DisablesTheBorrowPaths() public {
        (RentEscrowV2 escrow,,) = _deploy(address(0), TIMEOUT);
        assertEq(escrow.borrowerOpsSignatures(), address(0));
    }

    // ------------------------------------------------------------------ config checks

    function test_Deploy_RevertsOnBadConfig() public {
        vm.chainId(11155111); // anywhere but Mezo testnet
        vm.expectRevert(bytes("DeployEscrowV2: Mezo testnet (31611) only"));
        _deploy(address(signatures), TIMEOUT);
        vm.chainId(31611);

        vm.expectRevert(bytes("DeployEscrowV2: ESCROW_ARBITER is zero"));
        script.deploy(
            deployer, address(musd), address(0), address(0), GateChoiceV2.None, address(0), address(signatures), TIMEOUT
        );

        vm.expectRevert(bytes("DeployEscrowV2: ESCROW_ARBITER must not be the deployer (the demo landlord)"));
        script.deploy(
            deployer, address(musd), deployer, address(0), GateChoiceV2.None, address(0), address(signatures), TIMEOUT
        );

        vm.expectRevert(bytes("DeployEscrowV2: ESCROW_TOKEN has no code on this chain"));
        script.deploy(
            deployer,
            makeAddr("no-code"),
            arbiter,
            address(0),
            GateChoiceV2.None,
            address(0),
            address(signatures),
            TIMEOUT
        );

        vm.expectRevert(bytes("DeployEscrowV2: ESCROW_V2_DISPUTE_TIMEOUT must be > 0"));
        _deploy(address(signatures), 0);

        vm.expectRevert(bytes("DeployEscrowV2: ESCROW_V2_SIGNATURES has no code on this chain (use 'none' to disable)"));
        script.deploy(
            deployer, address(musd), arbiter, address(0), GateChoiceV2.None, address(0), makeAddr("no-code"), TIMEOUT
        );
    }

    function test_SignaturesFromEnv() public {
        // "default"/unset -> the Mezo testnet deployment; "none"/0x0 -> disabled; else parsed.
        assertEq(script.signaturesFromEnv("default"), 0xD757e3646AF370b15f32EB557F0F8380Df7D639e);
        assertEq(script.signaturesFromEnv(""), 0xD757e3646AF370b15f32EB557F0F8380Df7D639e);
        assertEq(script.signaturesFromEnv("none"), address(0));
        assertEq(script.signaturesFromEnv("0x0000000000000000000000000000000000000000"), address(0));
        assertEq(script.signaturesFromEnv("0x000000000000000000000000000000000000dEaD"), address(0xdEaD));
    }

    // ------------------------------------------------------------------ deployment record

    function test_Run_DoesNotRecordDeploymentsOutsideABroadcast() public {
        vm.setEnv("ESCROW_ARBITER", vm.toString(arbiter));
        vm.setEnv("ESCROW_TOKEN", vm.toString(address(musd)));
        vm.setEnv("LEASE_SHARE", vm.toString(address(0)));
        vm.setEnv("ESCROW_HUMAN_GATE", "none");
        vm.setEnv("ESCROW_V2_SIGNATURES", "none");
        vm.setEnv("ESCROW_V2_DISPUTE_TIMEOUT", "604800");
        vm.setEnv("BROADCAST", "true"); // an env flag alone must never trigger a write
        string memory file = script.DEPLOYMENTS_FILE();
        bool existed = vm.exists(file);
        string memory before = existed ? vm.readFile(file) : "";

        (RentEscrowV2 escrow,,) = script.run(); // not a --broadcast run: nothing reaches the chain
        assertEq(escrow.disputeTimeout(), 604_800, "env timeout was not picked up");
        assertEq(escrow.borrowerOpsSignatures(), address(0));

        assertEq(vm.exists(file), existed, "deployments.json created outside a broadcast");
        if (existed) assertEq(vm.readFile(file), before, "deployments.json rewritten outside a broadcast");
    }

    /// The record is a read-modify-write of the "mezoTestnetV2" key only: the live "mezoTestnet"
    /// entry (and "baseSepolia") survive untouched, and re-recording replaces the V2 entry.
    function test_Record_UpsertsV2AndKeepsEveryOtherKey() public {
        vm.createDir(SCRATCH_DIR, true);
        vm.copyFile(script.DEPLOYMENTS_FILE(), UPSERT_FILE);
        string memory original = vm.readFile(UPSERT_FILE);
        address liveEscrow = vm.parseJsonAddress(original, ".mezoTestnet.rentEscrow");
        address baseShare = vm.parseJsonAddress(original, ".baseSepolia.LeaseShare1155.address");

        address[5] memory a =
            [makeAddr("token"), makeAddr("arb"), makeAddr("gate"), makeAddr("escrow"), makeAddr("shares")];
        script.record(UPSERT_FILE, deployer, a[0], a[1], a[2], a[3], a[4], address(signatures), TIMEOUT);
        script.record(UPSERT_FILE, deployer, a[0], a[1], a[2], makeAddr("escrow2"), a[4], address(0), 1 days); // a redeploy

        string memory json = vm.readFile(UPSERT_FILE);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnet.rentEscrow"), liveEscrow, "live V1 entry changed");
        assertEq(vm.parseJsonAddress(json, ".baseSepolia.LeaseShare1155.address"), baseShare, "baseSepolia changed");

        assertEq(vm.parseJsonUint(json, ".mezoTestnetV2.chainId"), 31611);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.deployer"), deployer);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.token"), a[0]);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.arbiter"), a[1]);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.humanGate"), a[2]);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.leaseShare1155"), a[4]);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.borrowerOpsSignatures"), address(0));
        assertEq(vm.parseJsonUint(json, ".mezoTestnetV2.disputeTimeout"), 1 days);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.rentEscrowV2"), makeAddr("escrow2"));

        // Only the "mezoTestnetV2" entry is added once.
        uint256 before = vm.parseJsonKeys(original, "$").length;
        uint256 added = vm.keyExists(original, ".mezoTestnetV2") ? 0 : 1;
        assertEq(vm.parseJsonKeys(json, "$").length, before + added, "record added more than the mezoTestnetV2 entry");
        vm.removeFile(UPSERT_FILE);
    }

    function test_Record_CreatesAMissingFile() public {
        vm.createDir(SCRATCH_DIR, true);
        if (vm.exists(MISSING_FILE)) vm.removeFile(MISSING_FILE);
        script.record(
            MISSING_FILE,
            deployer,
            address(musd),
            arbiter,
            address(0),
            makeAddr("escrow"),
            address(0),
            address(signatures),
            TIMEOUT
        );
        string memory json = vm.readFile(MISSING_FILE);
        assertEq(vm.parseJsonAddress(json, ".mezoTestnetV2.rentEscrowV2"), makeAddr("escrow"));
        assertEq(vm.parseJsonUint(json, ".mezoTestnetV2.disputeTimeout"), TIMEOUT);
        vm.removeFile(MISSING_FILE);
    }
}
