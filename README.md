# Fanout

One change, many Safes, one signing pass.

Fanout replicates one administrative change (rotate signers, change threshold, any call) across
many Safes on many chains, then lets every signer sign all of them in one sitting and anyone
execute all of them in one more. It is a single static HTML file: no server, no database, no
accounts.

## Use it

**Proposer**
1. Paste the Safes, one per line: `eth:0xSafe`, a Safe{Wallet} link, or `0xSafe eth arb1 base 252`.
2. Write the change, one action per line:
   ```
   swap 0xOldOwner… winthorpe.eth      # also: 0xOld -> 0xNew
   add 0xNewOwner…
   remove 0xLeavingOwner…
   threshold 4
   0xToken… transfer(address,uint256) 0xTo… 1000000
   self 0x<raw calldata, may contain {self}>
   ```
   `swap/add/remove/threshold` are computed per Safe, because `prevOwner` depends on each Safe's
   owner order. `self` is each target Safe. You can also paste a Transaction Builder JSON, or
   import a queued Safe{Wallet} transaction by its link.
3. **Prepare.** Every Safe is read, built, simulated from its own context, and its hash checked
   against the Safe contract. Review the grouped actions and the table.
4. **Create signing link** and post it in the team chat.

**Signers**: open the link → compare the fingerprint with the proposer → Connect wallet → **Sign N**.
Requests arrive back to back; confirm each on the device. Signatures go straight to the Safe
Transaction Service, so they also show in Safe{Wallet}. The first signature on a transaction
creates the proposal.

**Executor** (anyone with gas on each chain): open the link → **Execute N**.

## How it works

| Concern | Where it lives |
|---|---|
| What to sign | The link fragment: compressed JSON, each distinct payload stored once with the Safe's own address as `{self}`. 27 Safes fit in about 1 KB. Never sent to a server. |
| Signatures | Safe Transaction Service, posted directly from the browser (CORS is open; no key needed). Chains without a service: a copy/paste signature bundle. |
| Owners, threshold, nonce, executed? | The chain, read through public RPCs (two per chain with failover; override in Settings). |
| Resume / retry | localStorage. On every open the service is re-read; any signature it doesn't have is re-posted. |

Checks before anyone signs: Safe version (1.3.0, 1.4.1, 1.5.0), `simulateAndRevert` of the exact
payload, local EIP-712 hash equal to the Safe's own `getTransactionHash`, conflicts with queued
transactions. Before each signature: a fresh nonce read, so nothing executed meanwhile is signed.
After each signature: recovery must equal the connected account. Before execution: an `eth_call`
of the full `execTransaction`.

Gas and refund fields are always zero (the executor pays gas). Multiple calls use
MultiSendCallOnly 1.3.0, the same contract Safe{Wallet}'s Transaction Builder uses, so a payload
built here hashes identically to one built there.

## Verify what you sign

- The fingerprint (e.g. `248c-e726`) covers every safeTxHash in the batch. Confirm it out of band.
- While signing, the current transaction's safeTxHash, domain hash and message hash are shown, so
  you can compare them with the device screen (Ledger blind signing shows domain + message hash).
- Host `dist/fanout.html` yourself and publish its sha256 (printed by the build) so signers can
  check they run the same file.

## Develop

```bash
bun install
bun test                         # unit tests; fork tests too if anvil + ETHEREUM_RPC_URL + ARBITRUM_RPC_URL are set
bun run build                    # dist/fanout.html + sha256
bun run dev                      # build and serve on http://localhost:5173
bun scripts/validate-example.ts  # read-only check of the 27-Safe rotation example on live chains
bun scripts/pick-rpcs.ts         # refresh src/chains.ts with CORS-capable public RPCs
```

`src/safe.ts` is the core (parsing, building, hashing, simulation, signatures, link format),
`src/service.ts` the throttled Safe Transaction Service client, and `src/app.ts` the UI (lit-html).

## Not supported (on purpose)

Safe < 1.3.0; contract owners (EIP-1271 signatures); WalletConnect and direct Ledger/Trezor USB
(use the device through Rabby, MetaMask or Frame); non-zero gas/refund fields; automatic nonce
juggling beyond "queue after pending transactions".
