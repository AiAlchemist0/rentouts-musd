// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DemoLandlord} from "../src/DemoLandlord.sol";
import {IRentEscrow} from "../src/interfaces/IRentEscrow.sol";

/// @notice Deploys DemoLandlord against an existing RentEscrow. Afterwards the LeaseShare1155 owner
///         must call `setAllowlist(demoLandlord, true)` so the escrow can mint its lease shares.
///         Env: ESCROW (RentEscrow address); optional DEMO_DEPOSIT, DEMO_RENT (token units),
///         DEMO_PERIOD (seconds), DEMO_PERIODS. Defaults: 20 / 10 MUSD (18 decimals), 60 s, 3 periods.
contract DeployDemoLandlord is Script {
    function run() external returns (DemoLandlord demo) {
        IRentEscrow escrow = IRentEscrow(vm.envAddress("ESCROW"));
        uint128 deposit = uint128(vm.envOr("DEMO_DEPOSIT", uint256(20e18)));
        uint128 rent = uint128(vm.envOr("DEMO_RENT", uint256(10e18)));
        uint32 period = uint32(vm.envOr("DEMO_PERIOD", uint256(60)));
        uint16 periods = uint16(vm.envOr("DEMO_PERIODS", uint256(3)));

        vm.startBroadcast();
        demo = new DemoLandlord(escrow, deposit, rent, period, periods);
        vm.stopBroadcast();
        console2.log("DemoLandlord", address(demo));
    }
}
