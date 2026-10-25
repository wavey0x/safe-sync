# Fanout

One change, many Safes, one signing pass.

Rotating signers (or making any other change) on a Safe that lives on 25 chains normally means 25
proposals, and then every signer clicks through 25 Safe{Wallet} screens. Fanout builds all of them
from one description, gives the team one link, and walks each signer through every signature in a
single sitting. It is one static HTML file: no server, no database, no accounts.

## Use it

**Proposer**: paste the Safes and the change, click **Prepare**, review, click **Create signing link**.

```text
# Safes: chain:0xSafe, a Safe{Wallet} link, or one address followed by chains
0x6d447e544D01a59cb0774763bf15526574CffFeD eth oeth bnb gno pol base arb1 avax frax taiko
eth:0x467947EE34aF926cF1DCac093870f613C96B1E0c

# Change: owner changes are worked out per Safe, because prevOwner depends on each Safe's owner order
swap 0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3 winthorpe.eth
swap 0xe9A65fe8190fA5A4b5E277b84f0aAce686FDc174 0x4046B37Ffc36B0C723d7Fc64e0C763B698D81934
# also: add 0x…   remove 0x…   threshold 4   0xToken… transfer(address,uint256) 0xTo… 1000   self 0x<calldata>
```

You can also paste a Transaction Builder JSON, or import a transaction already queued in Safe{Wallet}
by its link. Owner changes in it become `swap`/`add`/`remove`/`threshold` lines, and anything that
can't be replicated safely (an inner DELEGATECALL) is refused.

Prepare reads every Safe and builds its transaction. It simulates the transaction from the Safe's
own context and checks the hash against the Safe contract. Results come back in three groups: ready,
already applied, or needs attention. The review states the change in plain words ("Replace 0x99BC…
→ winthorpe.eth · Threshold stays 5-of-9"). Exact calldata and prevOwner values sit behind
*Technical details*. Editing the input throws the results away, so a link never carries stale
transactions.

**Signers**: open the link, compare the fingerprint with the proposer's, connect, click **Sign remaining N**.
Every Safe is listed. The one being signed is highlighted, with its safeTxHash, domain hash and
message hash to compare against the device. Each one turns into a green check as it completes. Pause
and account switches stop before the next request. Safes that already have enough signatures are
skipped. "You've signed all N" is shown separately from "Executed N of M".

**Executor**: anyone with gas opens the link and clicks **Execute N**.

## How it works

| Concern | Where it lives |
|---|---|
| What to sign | The link fragment: compressed JSON that stores each distinct payload once, with the Safe's own address as `{self}`. 27 Safes fit in about 1 KB, and the fragment is never sent to a server. |
| Signatures | Safe Transaction Service, posted straight from the browser, so they also show in Safe{Wallet}. The first signature on a transaction creates the proposal. Chains without a service use a copy/paste signature bundle. |
| Owners, threshold, nonce, executed? | The chain, through public RPCs (two per chain with failover; override them in Settings). |
| Resume / retry | localStorage, keyed by safeTxHash. Every open re-reads the service and re-uploads anything it lacks. Signatures survive editing a batch into a new link. |

Safe service calls stay at 1 request/second per browser and back off on 429. The public limits are
2/s per IP, or 5/s per account with a key, and teammates behind one network or one key share them.

Only ECDSA and eth_sign signatures count toward quorum. Approved-hash and contract signatures prove
nothing off-chain. Gas and refund fields are always zero, so the executor pays gas.

## Try it locally: the sandbox

```bash
bun run sandbox      # needs anvil (Foundry)
```

The sandbox opens http://localhost:8600 with everything wired to local stand-ins:

- **14 chains:** anvil instances with real chain ids. 12 of them have a Safe service; Fraxtal and Taiko don't.
- **Real contracts:** the canonical Safe 1.3.0 and 1.4.1 contracts, at their canonical addresses, copied from Ethereum into `test/fixtures`.
- **Safes:** a 5-of-9 team Safe at the same address on every chain, the "original" Safe on Ethereum with a different owner order, and a 1.4.1 Safe on Scroll.
- **The awkward cases:** different nonces, a rotation already done on Linea, a conflicting transaction queued on Gnosis, and the same rotation already queued with one signature.
- **A mock Safe Transaction Service** (`test/mock-service.ts`). It follows the real service's source (v6.13.0 at `83316729`, safe-eth-py 7.27.0): checksummed addresses only, hash check, sender must be an owner and one of the signers, re-proposing adds confirmations, DELEGATECALL only to MultiSend libraries, 422 vs 400 vs 404 bodies, strings for numbers, executions indexed from the chain, and 2 req/s throttling.
- **A sandbox wallet** (bottom-left) that signs as any owner and behaves like MetaMask: lowercase accounts, chainId must match, an optional rejection.

The draft is pre-filled: Prepare → Create signing link → Open to sign, then switch signers in the
sandbox wallet.

## Develop

```bash
bun install
bun test                         # unit tests + sandbox end-to-end (needs anvil); live ENS check with ETHEREUM_RPC_URL
bun run build                    # dist/fanout.html + its sha256: host it anywhere static, publish the hash
bun run dev                      # build and serve on http://localhost:5173
bun scripts/validate-example.ts  # read-only check of the 27-Safe Curve rotation against live chains
bun scripts/pick-rpcs.ts         # refresh src/chains.ts with CORS-capable public RPCs
```

`src/safe.ts` holds the core (parsing, per-Safe building, hashing, simulation, signatures, link
format). `src/service.ts` is the Safe service client and `src/app.ts` the UI (lit-html). Wallet
extensions don't inject into `file://` pages, so serve the file rather than opening it directly.

## Not supported, on purpose

Safe < 1.3.0; contract owners (EIP-1271); WalletConnect; direct USB to hardware wallets (use the
device through Rabby, MetaMask or Frame); non-zero gas or refund fields; nonce juggling beyond
"queue after pending transactions".
