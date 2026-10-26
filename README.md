# Safe Sync

Keep a Safe the same on every chain. **Use it: https://safe-sync-seven.vercel.app**

A team's Safe often lives at one address on 20+ chains. Rotating a signer, or making any other
change, normally means building the same transaction 20 times. Then every signer clicks through 20
Safe{Wallet} screens. Safe Sync finds the Safe on every chain, works out what each one needs, gives
the team one link, and walks each signer through every signature in one sitting. It is one static
HTML file: no server, no database, no accounts.

## Use it

**Proposer**: three steps, each on its own screen with Back and the next step at the bottom. The
browser's Back and Forward move between them, and a reload stays on the step you were on.

1. **Safe:** paste its address. It's looked up on every chain, and each chain it's on shows up as a
   chip; click a chip to leave that chain out. **+ Another address** adds a Safe that was deployed at a
   different address on some chains. **Continue** once at least one is selected.
2. **Build Txn**, one of two kinds:
   - **Owners:** **Reference Safe** chooses whose owners and threshold to copy; the most common
     configuration is selected initially. Changing the reference replaces draft edits. Then edit
     the owners: *Swap* or *Remove* any, *+ Add owner* (address or name.eth), and set
     the *Threshold*. That target is saved as it is and never recomputed from the chains, so Edit
     after a partial execution doesn't double count. Each Safe is compared with the target on its own:
     one that already matches is skipped, and one that drifted is brought in line. Chips whose owners
     differ from the starting list are marked amber. Chains you leave out stay left out after Edit.
   - **Other transaction:** paste a Safe{Wallet} transaction link or a Transaction Builder JSON. Owner
     changes in it are redone per Safe, and the source Safe's own address becomes each Safe's.
     DELEGATECALLs are refused, and every call target must exist on each chain.
3. **Review N Safes** checks the change first. Then each Safe is built, simulated from its own
   context, and hash-checked against the Safe contract. The review lists what the calldata does, one
   line per call: *Swap* out → in, *Add* in green, *Remove* in red, and the threshold only where a call
   changes it. Unchanged owners sit behind a toggle. Safes whose calls differ get their own group.
   Results come back as ready, already in sync, or needs attention, and each Safe's row opens to its
   exact steps.

   **Nonces** come from each Safe's queue in the Safe Transaction Service, and nothing queued is
   replaced unless you choose to:
   - Nothing queued: the Safe's on-chain nonce.
   - This same transaction already queued: its nonce, so its signatures count.
   - Something else queued and signed: after it by default. Unsigned proposals don't count, since
     anyone can post one. That Safe's row gets a choice, *Nonce 7 · after 2 queued* or *Nonce 5 ·
     replace* (Safe{Wallet}'s word for a competing transaction at the same nonce). Opening the row
     lists what's queued, linked to Safe{Wallet}. With two or more such Safes, *After queue* /
     *Replace* sets them all. Choices are kept in the draft, and changing one redoes only that Safe.
   - The queue couldn't be read: the Safe needs attention, with ↻, and stays out of the link until it's
     read. Chains without a Safe service use the on-chain nonce.
4. **Copy signing link** creates the link and copies it ("Copied ✓"); *Propose now* opens it, so you
   can put it in Safe{Wallet} yourself (see below). Going back without changing anything keeps the
   results; any edit throws them away, so a link never carries stale transactions. *Edit* on a signing
   link reopens it at Build Txn.

**Proposing**: whoever opens the link and connects can put each transaction in the Safe service, so
it shows up in Safe{Wallet}. One button does what the account can:

- **An owner** signs (*Sign N*). The first signature on a transaction creates the proposal.
- **A proposer** (a delegate an owner added in Safe{Wallet}) signs to propose (*Propose N*). That
  makes the proposal trusted, so Safe{Wallet} lists it, but it isn't a confirmation.
- **Anyone else** proposes unsigned, with no wallet prompt. The service still allows that, as long
  as an owner is named as the sender, so the first owner is named and the proposal's origin records
  who really sent it. An unsigned proposal stays out of Safe{Wallet}'s queue until an owner signs it
  (a direct link to it works), and anyone could post one, so other unsigned proposals at the same nonce
  don't count as competitors.

**Signers**: open the link, check the code next to the title with whoever sent it, connect, then click **Sign N**. The title says what the link does ("Swap 2 owners on 15 Safes").

- Every Safe is listed with a mark: ✓ you signed (or proposed) it, ○ it needs you, – nothing for you
  to do, ! a problem, a dashed ring for yours that isn't in the Safe service yet (yellow when the
  upload failed), and a thin spinner while it's still being read. Hover or focus a mark for the
  details. The one being signed is highlighted, with its safeTxHash, domain hash and message hash to
  compare against the device.
- Reading the Safe service is slow (see below), so the page fills in Safe by Safe. Waiting that holds
  you up shows as a spinner on the button it blocks, saying what it's waiting for. Background reading
  is a quiet line that blocks nothing: *Sign N* works while Safes are still loading, and waits for
  each one before asking the wallet.
- Safes that already have enough signatures are skipped. Pause (and Edit) stop before the next request,
  keeping the one already open in the wallet. Another transaction queued at the same nonce is flagged on
  its row.
- When you're done, it says so, unless signatures still need uploading or sharing. In that case it
  says which, and offers the button to fix it.

**Executor**: anyone with gas opens the link and clicks **Execute N**. Only a successful receipt counts
as executed.

## How it works

| Concern | Where it lives |
|---|---|
| What to sign | The link fragment: compressed JSON that stores each distinct payload once, with the Safe's own address as `{self}`. 27 Safes fit in about 1 KB, and the fragment is never sent to a server. |
| Signatures | Safe Transaction Service, posted straight from the browser, so they also show in Safe{Wallet}. The first signature on a transaction creates the proposal. Safe runs the service on most chains; on Fraxtal it's Frax's (`safe.mainnet.frax.com`), on Taiko Protofire's (`app.safe.protofire.io`), and links open in those apps. Override any in Settings. When a service can't be reached, signatures travel as a copy/paste bundle. |
| Owners, threshold, nonce, executed? | The chain, through public RPCs (two per chain with failover; override them in Settings). One service request per Safe returns this transaction and anything else at its nonce. |
| Resume / retry | localStorage, keyed by safeTxHash. Every open re-reads the service and re-uploads anything it lacks. Signatures survive editing a batch into a new link. |

Safe service calls stay at 1 request/second per browser (2.5 with an API key) and back off on 429.
The public limits are 2/s per IP, or 5/s per account with a key, and teammates behind one network or
one key share them. Each service host keeps its own pace, so Fraxtal and Taiko don't wait behind
Safe's.

Only ECDSA and eth_sign signatures count toward quorum. Gas and refund fields are always zero, so the
executor pays gas.

## Try it locally: the sandbox

```bash
bun run sandbox                                  # 14 local chains with real chain ids; sandbox wallet only
bun run sandbox -- --signer 0xA,0xB --port 8700  # also make your addresses owners, on other ports
bun run sandbox:simple                           # a 2-of-2 Safe on 3 local-only chains, for your own wallet
```

- **Full sandbox:**
  - 14 anvil chains with real chain ids, all served by the mock Safe service (never a real one).
  - The canonical Safe 1.3.0 and 1.4.1 contracts at their canonical addresses (fixtures in `test/fixtures`).
  - A 5-of-9 team Safe everywhere, a reordered "original" Safe on Ethereum, and a 1.4.1 Safe on Scroll.
  - Mixed nonces, a rotation already done on Linea, other transactions already queued on Gnosis (one)
    and Polygon (two), and the same rotation already queued with one signature.
  - A proposer (a delegate of owner 2) in the sandbox wallet, to try proposing signed; "Not an owner"
    proposes unsigned.
  - Other wallets are hidden here: with real chain ids, a real wallet would send executions to the
    real networks.
- **Simple sandbox:** chain ids 31338 to 31340 belong to no real network, so your wallet adds them as
  local networks and can sign and execute safely. It defaults to the first two test accounts as
  owners. Remove those networks from your wallet afterwards.
- **Both:** a mock Safe Transaction Service (`test/mock-service.ts`) that follows the real service's
  source (v6.13.0 at `83316729`, safe-eth-py 7.27.0): checksummed addresses, hash check, the sender must
  be one of the signers, get-or-create proposals, delegates (proposers) and unsigned, untrusted
  proposals, DELEGATECALL only to MultiSend, 422/400/404 bodies, executions indexed from the chain, and
  2 req/s throttling. There's also a sandbox wallet
  (bottom-left) that signs as any test account.

## Develop

```bash
bun install
bun test                         # unit tests + sandbox end-to-end (needs anvil); live ENS check with ETHEREUM_RPC_URL
bun run build                    # dist/safe-sync.html + its sha256: host it anywhere static, publish the hash
bun run dev                      # build and serve on http://localhost:5173
bun scripts/validate-example.ts  # read-only check of the 27-Safe Curve rotation against live chains
bun scripts/pick-rpcs.ts         # refresh src/chains.ts with public RPCs that answer a browser on the app's origin
```

`src/safe.ts` is the core: finding Safes, per-Safe owner sync, the import conversion, hashing,
simulation, signatures and the link format. `src/service.ts` is the Safe service client and
`src/app.ts` the UI (lit-html). Wallet extensions don't inject into `file://` pages, so serve the file
rather than opening it directly.

## Host it

It's one static file, so any HTTPS host works. Nothing needs a proxy: the Safe Transaction Service and
the default RPCs allow any origin, and each user's browser makes its own calls (so Safe's rate limits
are per user, not per site). This repo deploys to Vercel from `main`:

- `vercel.json` serves `dist/safe-sync.html` exactly as committed, with no build on Vercel, so the
  live file matches the sha256 the build printed. Rebuild and commit `dist` with every change.
- Headers stop other sites from framing the signing page (`frame-ancestors 'none'`,
  `X-Frame-Options`), and send no referrer.
- Don't put a Safe API key in the build: anyone could read it. Users paste their own in Settings,
  where it stays in their browser.
- Links point at the site that made them, and each site keeps its own drafts and signature cache.

## Not supported, on purpose

Safe < 1.3.0; contract owners (EIP-1271); WalletConnect; direct USB to hardware wallets (use the
device through Rabby, MetaMask or Frame); non-zero gas or refund fields; nonces other than "after the
queue" or "replace the lowest".
