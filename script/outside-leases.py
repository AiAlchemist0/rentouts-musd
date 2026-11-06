"""Lists RentEscrowV2 leases whose tenant or landlord is outside the team. Read-only.

python script/outside-leases.py   (needs Foundry cast)
"""
import subprocess

RPC = "https://rpc.test.mezo.org"
ESCROW = "0xE9c9230DE785504c7D383EfEC46cfCa328e257e4"
TEAM = {
    "0xca46bc7646fd202f0e20e0c8ce16093a3c4d33c6": "deployer/landlord",
    "0xc262d36287dbe2eda5cb3d776f9e527e24b51719": "demo tenant",
    "0x61e6e29c48878142e25d8bebdade3e584fcddce1": "wave1 tenant",
    "0x8cf3f01e8ec43791758768d72993d192a87653ed": "DemoLandlordV2",
    "0x1da334a5fab59a741fdae7f081c7f592027b3106": "arbiter",
}


def call(sig, *args):
    return subprocess.run(["cast", "call", ESCROW, sig, *map(str, args), "--rpc-url", RPC],
                          capture_output=True, text=True, check=True).stdout.strip()


def addr(word):
    return "0x" + word[-40:]


n = int(call("nextLeaseId()(uint256)").split()[0])
outside = 0
for i in range(1, n):
    raw = call("getLease(uint256)", i)[2:]
    landlord, tenant = addr(raw[0:64]), addr(raw[64:128])
    balance = int(call("escrowBalance(uint256)(uint256)", i).split()[0]) / 1e18
    who = [f"{role} {a[:8]}...{a[-4:]} ({TEAM.get(a, 'OUTSIDE')})" for role, a in (("landlord", landlord), ("tenant", tenant))]
    flag = "  <-- outside user" if landlord not in TEAM or tenant not in TEAM else ""
    outside += bool(flag)
    print(f"#{i}: {' | '.join(who)} | escrow {balance:g} MUSD{flag}")
print(f"\n{n - 1} leases, {outside} with an outside party")
