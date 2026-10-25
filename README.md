# Safe Sync

Keep a Safe the same on every chain.

A team's Safe often lives at one address on 20+ chains. Rotating a signer, or making any other
change, normally means building the same transaction 20 times. Then every signer clicks through 20
Safe{Wallet} screens. Safe Sync finds the Safe on every chain, works out what each one needs, gives
the team one link, and walks each signer through every signature in one sitting. It is one static
HTML file: no server, no database, no accounts.

## Use it

**Proposer**

1. **Safe:** paste its address. It's looked up on every chain, and each chain it's on shows up as a
   chip; click a chip to leave that chain out. **+ Another address** adds a Safe that was deployed at a
   different address on some chains.
2. **Change**, one of two kinds:
   - **Owners:** the current owners are listed. *Replace* or *Remove* any of them, *+ Add owner*
     (address or name.eth), and set *Signatures needed*. Each Safe is compared with the resulting list
     on its own, so a Safe that already matches is skipped and one that drifted is brought in line.
     Chips with different owners are marked amber.
   - **Other transaction:** paste a Safe{Wallet} transaction link or a Transaction Builder JSON. Owner
     changes in it are redone per Safe, and the source Safe's own address becomes each Safe's.
     DELEGATECALLs are refused, and every call target must exist on each chain.
3. **Review:** each Safe is built, simulated from its own context, and hash-checked against the Safe
   contract. Results come back as ready, already in sync, or needs attention, with the change in plain
   words. Exact calldata sits behind *Technical details*.
4. **Create signing link**, then *Copy link* or *Sign now*. Editing anything throws the results away, so
   a link never carries stale transactions.

**Signers**: open the link, check the code next to the title with whoever sent it, connect, then click **Sign N**. The title says what the link does ("Replace 2 owners on 15 Safes").

- Every Safe is listed. The one being signed is highlighted, with its safeTxHash, domain hash and
  message hash to compare against the device. Each Safe turns into a green check as it completes.
- Safes that already have enough signatures are skipped. Pause stops before the next request, after
  the one already open in the wallet. Another transaction queued at the same nonce is flagged on its row.
- When you're done, it says so, unless signatures still need uploading or sharing. In that case it
  says which, and offers the button to fix it.

**Executor**: anyone with gas opens the link and clicks **Execute N**. Only a successful receipt counts
as executed.

## How it works

| Concern | Where it lives |
|---|---|
| What to sign | The link fragment: compressed JSON that stores each distinct payload once, with the Safe's own address as `{self}`. 27 Safes fit in about 1 KB, and the fragment is never sent to a server. |
| Signatures | Safe Transaction Service, posted straight from the browser, so they also show in Safe{Wallet}. The first signature on a transaction creates the proposal. Chains without a service use a copy/paste signature bundle. |
| Owners, threshold, nonce, executed? | The chain, through public RPCs (two per chain with failover; override them in Settings). One service request per Safe returns this transaction and anything else at its nonce. |
| Resume / retry | localStorage, keyed by safeTxHash. Every open re-reads the service and re-uploads anything it lacks. Signatures survive editing a batch into a new link. |

Safe service calls stay at 1 request/second per browser and back off on 429. The public limits are
2/s per IP, or 5/s per account with a key, and teammates behind one network or one key share them.

Only ECDSA and eth_sign signatures count toward quorum. Gas and refund fields are always zero, so the
executor pays gas.

## Try it locally: the sandbox

```bash
bun run sandbox                                  # 14 local chains with real chain ids; sandbox wallet only
bun run sandbox -- --signer 0xA,0xB --port 8700  # also make your addresses owners, on other ports
bun run sandbox:simple                           # a 2-of-2 Safe on 3 local-only chains, for your own wallet
```

- **Full sandbox:**
  - 14 anvil chains with real chain ids. Fraxtal and Taiko have no Safe service.
  - The canonical Safe 1.3.0 and 1.4.1 contracts at their canonical addresses (fixtures in `test/fixtures`).
  - A 5-of-9 team Safe everywhere, a reordered "original" Safe on Ethereum, and a 1.4.1 Safe on Scroll.
  - Mixed nonces, a rotation already done on Linea, a conflicting queued transaction on Gnosis, and
    the same rotation already queued with one signature.
  - Other wallets are hidden here: with real chain ids, a real wallet would send executions to the
    real networks.
- **Simple sandbox:** chain ids 31338 to 31340 belong to no real network, so your wallet adds them as
  local networks and can sign and execute safely. It defaults to the first two test accounts as
  owners. Remove those networks from your wallet afterwards.
- **Both:** a mock Safe Transaction Service (`test/mock-service.ts`) that follows the real service's
  source (v6.13.0 at `83316729`, safe-eth-py 7.27.0): checksummed addresses, hash check, the sender must
  be one of the signers, get-or-create proposals, DELEGATECALL only to MultiSend, 422/400/404 bodies,
  executions indexed from the chain, and 2 req/s throttling. There's also a sandbox wallet
  (bottom-left) that signs as any test account.

## Develop

```bash
bun install
bun test                         # unit tests + sandbox end-to-end (needs anvil); live ENS check with ETHEREUM_RPC_URL
bun run build                    # dist/safe-sync.html + its sha256: host it anywhere static, publish the hash
bun run dev                      # build and serve on http://localhost:5173
bun scripts/validate-example.ts  # read-only check of the 27-Safe Curve rotation against live chains
bun scripts/pick-rpcs.ts         # refresh src/chains.ts with CORS-capable public RPCs
```

`src/safe.ts` is the core: finding Safes, per-Safe owner sync, the import conversion, hashing,
simulation, signatures and the link format. `src/service.ts` is the Safe service client and
`src/app.ts` the UI (lit-html). Wallet extensions don't inject into `file://` pages, so serve the file
rather than opening it directly.

## Not supported, on purpose

Safe < 1.3.0; contract owners (EIP-1271); WalletConnect; direct USB to hardware wallets (use the
device through Rabby, MetaMask or Frame); non-zero gas or refund fields; nonce juggling beyond
"queue after pending transactions".
