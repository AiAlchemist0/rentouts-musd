// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {IRentEscrowV2} from "../src/interfaces/IRentEscrowV2.sol";
import {DemoLandlordV2} from "../src/DemoLandlordV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";

/// @notice Deploys DemoLandlordV2 against an existing RentEscrowV2. Creating a lease mints its
///         shares to the landlord, so the demo landlord must be allowlisted on the escrow's
///         LeaseShare1155: when the broadcaster owns that share contract the script allowlists it
///         in the same broadcast (the way DeployEscrowV2 allowlists its own deployer); otherwise it
///         only logs the one manual step left (`setAllowlist(demoLandlord, true)` as the owner).
///         Env: ESCROW (RentEscrowV2 address); optional DEMO_DEPOSIT, DEMO_RENT (token units),
///         DEMO_PERIOD (seconds), DEMO_PERIODS. Defaults: 20 / 10 MUSD (18 decimals), 120 s, 3
///         periods — a full prepaid demo is 50 MUSD, a monthly one starts at 30 MUSD.
contract DeployDemoLandlordV2 is Script {
    function run() external returns (DemoLandlordV2 demo) {
        IRentEscrowV2 escrow = IRentEscrowV2(vm.envAddress("ESCROW"));
        uint128 deposit = uint128(vm.envOr("DEMO_DEPOSIT", uint256(20e18)));
        uint128 rent = uint128(vm.envOr("DEMO_RENT", uint256(10e18)));
        uint32 period = uint32(vm.envOr("DEMO_PERIOD", uint256(120)));
        uint16 periods = uint16(vm.envOr("DEMO_PERIODS", uint256(3)));

        demo = deploy(msg.sender, escrow, deposit, rent, period, periods);
    }

    /// @notice Checks the config, then deploys the demo landlord and allowlists it on the escrow's
    ///         LeaseShare1155 when the broadcaster can. Separate from run() so tests can exercise
    ///         every check without env vars.
    function deploy(
        address deployer,
        IRentEscrowV2 escrow,
        uint128 deposit,
        uint128 rent,
        uint32 period,
        uint16 periods
    ) public returns (DemoLandlordV2 demo) {
        require(deployer != DEFAULT_SENDER, "DeployDemoLandlordV2: pass --account <keystore> / --sender <address>");
        require(address(escrow).code.length > 0, "DeployDemoLandlordV2: ESCROW has no code on this chain");

        vm.startBroadcast(deployer);
        demo = new DemoLandlordV2(IRentEscrowV2(address(escrow)), deposit, rent, period, periods);

        address shares = escrow.leaseShare();
        if (shares != address(0)) {
            LeaseShare1155 share = LeaseShare1155(shares);
            if (share.owner() == deployer) {
                if (!share.allowlisted(address(demo))) share.setAllowlist(address(demo), true);
                console2.log("LeaseShare1155        ", shares, "(demo landlord allowlisted)");
            } else {
                // Not ours to fix here: tell the runner exactly what is left to do.
                console2.log("LeaseShare1155        ", shares, "(NOT owned by the broadcaster)");
                console2.log("manual step           : setAllowlist(demoLandlord, true) as the share owner");
            }
        } else {
            console2.log("LeaseShare1155        ", "none on this escrow (no allowlist needed)");
        }
        vm.stopBroadcast();

        console2.log("escrow                ", address(escrow));
        console2.log("terms: deposit / rent ", deposit, rent);
        console2.log("terms: period / count ", period, periods);
        console2.log("DemoLandlordV2        ", address(demo));
    }
}
