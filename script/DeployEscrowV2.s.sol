// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {HumanGate} from "../src/HumanGate.sol";
import {IHumanGate} from "../src/interfaces/IHumanGate.sol";

/// @dev forge-std's VmSafe.ForgeContext and vm.isContext, declared here because the vendored
///      forge-std (under lib/openzeppelin-contracts) predates them. Same order, same selector.
enum ForgeContextV2 {
    TestGroup,
    Test,
    Coverage,
    Snapshot,
    ScriptGroup,
    ScriptDryRun,
    ScriptBroadcast,
    ScriptResume,
    Unknown
}

interface IVmForgeContextV2 {
    function isContext(ForgeContextV2 context) external view returns (bool result);
}

/// @notice What the deploy does about RentEscrowV2's (immutable) human gate. From env ESCROW_HUMAN_GATE:
///         unset, "" or "new" -> DeployNew; "none" or the zero address -> None; any other address -> Existing.
enum GateChoiceV2 {
    DeployNew, // a new HumanGate owned by the deployer, open (verifier 0) until World ID is plugged in
    None, // humanGate = address(0): funding is never gated, and never can be on this escrow
    Existing // an IHumanGate that is already deployed
}

/// @notice Deploys RentEscrowV2 (the Wave-2 escrow) to Mezo testnet, wired to a LeaseShare1155 (a
///         new one owned by the deployer unless LEASE_SHARE points at an unused one the deployer
///         owns), to a human gate (by default a new HumanGate owned by the deployer, open until
///         World ID is plugged in with HumanGate.setVerifier), to Mezo's
///         BorrowerOperationsSignatures (default: the testnet deployment; "none" disables
///         borrowAndFund / withdrawAndFund) and to a dispute timeout (default 30 days).
///         One LeaseShare1155 per escrow: a share contract already wired to an escrow is refused.
///         Signs with a Foundry keystore account (--account); never takes a raw private key.
///
///   Env: MEZO_TESTNET_RPC_URL / --rpc-url mezo_testnet
///        ESCROW_ARBITER             required. An EOA or a contract (e.g. a Safe multisig, or an
///                                   arbiter contract deployed separately beforehand). Never the
///                                   deployer and never a lease party. Immutable: choose before
///                                   deploying.
///        ESCROW_TOKEN               optional. Default: MUSD on Mezo testnet.
///        ESCROW_HUMAN_GATE          optional. Unset / "new": deploy a HumanGate (owner = deployer,
///                                   verifier 0 = open). "none" or 0x0: no gating at all. An
///                                   address: an existing IHumanGate.
///        LEASE_SHARE                optional. An unused LeaseShare1155 the deployer owns.
///        ESCROW_V2_SIGNATURES       optional. Default: Mezo testnet BorrowerOperationsSignatures
///                                   (0xD757e3646AF370b15f32EB557F0F8380Df7D639e). "none" or 0x0:
///                                   borrow/withdraw funding disabled on this escrow.
///        ESCROW_V2_DISPUTE_TIMEOUT  optional. Seconds a dispute stays open before resolveByTimeout
///                                   may fire. Default: 30 days. Must be > 0.
///
///   Dry run (simulation only, records nothing):
///     forge script script/DeployEscrowV2.s.sol --profile mezo --rpc-url mezo_testnet --sender <deployer>
///   Deploy (also records the "mezoTestnetV2" entry of deployments.json; every other entry,
///   including "mezoTestnet", is left as it is):
///     forge script script/DeployEscrowV2.s.sol --profile mezo --rpc-url mezo_testnet \
///       --account <keystore-name> --sender <deployer> --broadcast
contract DeployEscrowV2 is Script {
    /// @dev Mezo testnet — the Wave-2 escrow is Mezo-bound: its new funding paths relay Mezo Borrow.
    uint256 internal constant MEZO_TESTNET_CHAIN_ID = 31611;
    address internal constant MEZO_TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant MEZO_TESTNET_BORROWER_OPS_SIGNATURES = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    uint256 internal constant DEFAULT_DISPUTE_TIMEOUT = 30 days;
    string internal constant SHARE_URI = "https://rentouts.co/api/lease-share/{id}.json";
    /// @dev The repo-wide deployments record; this script only ever writes the "mezoTestnetV2" key.
    string public constant DEPLOYMENTS_FILE = "./deployments.json";

    /// @dev Everything run() reads from env (kept in one struct: the flat locals overflow the stack).
    struct Config {
        address deployer; // the --sender / --account address
        address token;
        address arbiter;
        address existingShares;
        GateChoiceV2 gateChoice;
        address existingGate;
        address signatures;
        uint64 disputeTimeout;
    }

    function run() external returns (RentEscrowV2 escrow, LeaseShare1155 shares, address humanGate) {
        Config memory c = _configFromEnv();
        (escrow, shares, humanGate) = deploy(
            c.deployer,
            c.token,
            c.arbiter,
            c.existingShares,
            c.gateChoice,
            c.existingGate,
            c.signatures,
            c.disputeTimeout
        );

        // Record only when forge really broadcasts (--broadcast, or --resume), never in a dry run or
        // a test. forge runs the script before it sends the transactions, so if the broadcast does
        // not complete, check the addresses against broadcast/DeployEscrowV2.s.sol/31611/run-latest.json
        // (which also holds the deploy transaction hashes; they do not exist yet at this point).
        IVmForgeContextV2 ctx = IVmForgeContextV2(address(vm));
        if (ctx.isContext(ForgeContextV2.ScriptBroadcast) || ctx.isContext(ForgeContextV2.ScriptResume)) {
            record(
                DEPLOYMENTS_FILE,
                c.deployer,
                c.token,
                c.arbiter,
                humanGate,
                address(escrow),
                address(shares),
                c.signatures,
                c.disputeTimeout
            );
            console2.log("recorded", DEPLOYMENTS_FILE, "mezoTestnetV2");
        } else {
            console2.log("no --broadcast: simulation only, deployments.json not written");
        }
    }

    /// @notice Reads every env variable (see the contract NatSpec for the meanings and defaults).
    function _configFromEnv() internal view returns (Config memory c) {
        c.deployer = msg.sender;
        c.token = vm.envOr("ESCROW_TOKEN", MEZO_TESTNET_MUSD);
        c.arbiter = vm.envAddress("ESCROW_ARBITER");
        c.existingShares = vm.envOr("LEASE_SHARE", address(0));
        (c.gateChoice, c.existingGate) = gateFromEnv(vm.envOr("ESCROW_HUMAN_GATE", string("")));
        c.signatures = signaturesFromEnv(vm.envOr("ESCROW_V2_SIGNATURES", string("default")));
        uint256 timeoutRaw = vm.envOr("ESCROW_V2_DISPUTE_TIMEOUT", DEFAULT_DISPUTE_TIMEOUT);
        require(timeoutRaw <= type(uint64).max, "DeployEscrowV2: ESCROW_V2_DISPUTE_TIMEOUT does not fit in 64 bits");
        c.disputeTimeout = uint64(timeoutRaw);
    }

    /// @notice Parses ESCROW_HUMAN_GATE (see the contract NatSpec).
    function gateFromEnv(string memory raw) public pure returns (GateChoiceV2 choice, address existingGate) {
        bytes32 h = keccak256(bytes(raw));
        if (h == keccak256("") || h == keccak256("new")) return (GateChoiceV2.DeployNew, address(0));
        if (h == keccak256("none")) return (GateChoiceV2.None, address(0));
        existingGate = vm.parseAddress(raw);
        choice = existingGate == address(0) ? GateChoiceV2.None : GateChoiceV2.Existing;
    }

    /// @notice Parses ESCROW_V2_SIGNATURES: "default" (or "") -> the Mezo testnet deployment,
    ///         "none" (or 0x0) -> disabled, anything else -> that address.
    function signaturesFromEnv(string memory raw) public pure returns (address) {
        bytes32 h = keccak256(bytes(raw));
        if (h == keccak256("") || h == keccak256("default")) return MEZO_TESTNET_BORROWER_OPS_SIGNATURES;
        if (h == keccak256("none")) return address(0);
        address parsed = vm.parseAddress(raw);
        return parsed == address(0) ? address(0) : parsed;
    }

    /// @notice Writes (or replaces) the "mezoTestnetV2" entry of the deployments file at `path`,
    ///         keeping every other entry (e.g. "mezoTestnet", "baseSepolia") as it is. Creates the
    ///         file if it is missing.
    function record(
        string memory path,
        address deployer,
        address token,
        address arbiter,
        address humanGate,
        address rentEscrowV2,
        address leaseShare1155,
        address borrowerOpsSignatures,
        uint64 disputeTimeout
    ) public {
        string memory key = "mezoTestnetV2";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "token", token);
        vm.serializeAddress(key, "arbiter", arbiter);
        vm.serializeAddress(key, "humanGate", humanGate);
        vm.serializeAddress(key, "leaseShare1155", leaseShare1155);
        vm.serializeAddress(key, "borrowerOpsSignatures", borrowerOpsSignatures);
        vm.serializeUint(key, "disputeTimeout", disputeTimeout);
        string memory json = vm.serializeAddress(key, "rentEscrowV2", rentEscrowV2);
        if (!vm.exists(path)) vm.writeFile(path, "{}");
        vm.writeJson(json, path, string.concat(".", key)); // read-modify-write of this one key
        vm.writeFile(path, string.concat(vm.readFile(path), "\n")); // keep the trailing newline
    }

    /// @notice Checks the config, then deploys and wires the contracts as `deployer`. Separate from
    ///         run() so test/DeployEscrowV2.t.sol can exercise every check without env vars.
    /// @param existingGate the IHumanGate to use when gateChoice == Existing (ignored otherwise)
    function deploy(
        address deployer,
        address token,
        address arbiter,
        address existingShares,
        GateChoiceV2 gateChoice,
        address existingGate,
        address signatures,
        uint64 disputeTimeout
    ) public returns (RentEscrowV2 escrow, LeaseShare1155 shares, address humanGate) {
        require(block.chainid == MEZO_TESTNET_CHAIN_ID, "DeployEscrowV2: Mezo testnet (31611) only");
        require(deployer != DEFAULT_SENDER, "DeployEscrowV2: pass --account <keystore> / --sender <address>");
        require(token.code.length > 0, "DeployEscrowV2: ESCROW_TOKEN has no code on this chain");
        require(arbiter != address(0), "DeployEscrowV2: ESCROW_ARBITER is zero");
        // The arbiter may be an EOA or a contract (a Safe, an arbiter contract). The deployer is
        // allowlisted below as the demo landlord, and RentEscrowV2 refuses any lease whose landlord
        // or tenant is the arbiter: the arbiter must be someone else.
        require(arbiter != deployer, "DeployEscrowV2: ESCROW_ARBITER must not be the deployer (the demo landlord)");
        require(disputeTimeout > 0, "DeployEscrowV2: ESCROW_V2_DISPUTE_TIMEOUT must be > 0");
        if (signatures != address(0)) {
            require(
                signatures.code.length > 0,
                "DeployEscrowV2: ESCROW_V2_SIGNATURES has no code on this chain (use 'none' to disable)"
            );
        }
        if (gateChoice == GateChoiceV2.Existing) {
            require(existingGate.code.length > 0, "DeployEscrowV2: ESCROW_HUMAN_GATE has no code on this chain");
            // RentEscrowV2 will call isVerified(tenant) in every funding path: make sure the gate answers.
            try IHumanGate(existingGate).isVerified(deployer) returns (bool) {}
            catch {
                revert("DeployEscrowV2: ESCROW_HUMAN_GATE does not answer isVerified(address)");
            }
        }
        if (existingShares != address(0)) {
            require(existingShares.code.length > 0, "DeployEscrowV2: LEASE_SHARE has no code on this chain");
            LeaseShare1155 existing = LeaseShare1155(existingShares);
            // The escrow can only mint lease shares if the deployer can make it the minter.
            require(existing.owner() == deployer, "DeployEscrowV2: deployer must own LEASE_SHARE");
            // One LeaseShare1155 per escrow: lease ids restart at 1 in every escrow and
            // tokenId == leaseId, so re-wiring a share contract would put two escrows' leases under
            // the same tokenId (and stop the old escrow from listing).
            require(existing.minter() == address(0), "DeployEscrowV2: LEASE_SHARE already wired to an escrow");
            require(existing.totalSupply(1) == 0, "DeployEscrowV2: LEASE_SHARE already has shares of tokenId 1");
        }

        vm.startBroadcast(deployer);
        shares = existingShares == address(0)
            ? new LeaseShare1155(deployer, SHARE_URI)  // constructor allowlists the owner
            : LeaseShare1155(existingShares);
        if (gateChoice == GateChoiceV2.DeployNew) {
            humanGate = address(new HumanGate(deployer, address(0))); // open until setVerifier(World)
        } else if (gateChoice == GateChoiceV2.Existing) {
            humanGate = existingGate;
        } // GateChoiceV2.None: humanGate stays address(0)
        escrow = new RentEscrowV2(IERC20(token), arbiter, address(shares), humanGate, signatures, disputeTimeout);
        shares.setMinter(address(escrow));
        if (!shares.allowlisted(deployer)) shares.setAllowlist(deployer, true);
        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("deployer              ", deployer);
        console2.log("token                 ", token, IERC20Metadata(token).symbol());
        console2.log("token decimals        ", IERC20Metadata(token).decimals());
        console2.log("arbiter               ", arbiter, arbiter.code.length > 0 ? "(contract)" : "(EOA)");
        console2.log("disputeTimeout        ", disputeTimeout, "s");
        console2.log("LeaseShare1155        ", address(shares), existingShares == address(0) ? "(new)" : "(existing)");
        console2.log(
            "HumanGate             ",
            humanGate,
            gateChoice == GateChoiceV2.DeployNew
                ? "(new, owner = deployer, open)"
                : gateChoice == GateChoiceV2.Existing ? "(existing)" : "(none: funding not gated)"
        );
        console2.log(
            "BorrowerOpsSignatures ",
            signatures,
            signatures == address(0) ? "(none: borrow funding disabled)" : "(Mezo Borrow relay)"
        );
        console2.log("RentEscrowV2          ", address(escrow));
    }
}
