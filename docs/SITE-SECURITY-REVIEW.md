# Security review of the launch site (self-review, milestone 5)

> This is an internal review by the same developer who wrote the code, like
> [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) for the program. It does not replace an external
> review; one is still recommended before the site handles mainnet SOL.

## Scope

| | |
|---|---|
| Site | `app/`, as live on devnet at <https://sniper-tax-launch-devnet.majoco21.workers.dev>. Reviewed: `main` at `65af0ee` (11 November 2026), the build with script `index-Dp3tQour.js` |
| Fixes | On the branch of this review; see "Summary" and the tests named per finding |
| Also covered | The response headers and the Content-Security-Policy, the dependencies and lockfile, the CI workflow, the Cloudflare build and deploy path, and the vendored Pipeline SDK as far as the site calls it |
| Not covered | The program (see `SECURITY-REVIEW.md`), Pipeline's router and API themselves, wallets, and Cloudflare's and GitHub's own security |
| Method | Every page, every place a transaction is built, simulated or signed, and every piece of outside data (RPC, API, token metadata, the URL) walked through from an attacker's point of view. Each suspicion was confirmed or refuted with a test where possible: unit tests, and the built site in Chromium with a stand-in wallet against a stand-in RPC and API that play the hostile roles (`app/test/browser.e2e.test.ts`) |

**Who can attack, and with what:**

| Attacker | Controls |
|---|---|
| Anyone with a wallet | A pool of our program for any token, with any name, symbol, image link and Token-2022 extensions the program allows, against any quote mint. It appears on the launch list by itself |
| Anyone with a link | The URL a visitor opens (`#/pool/<address>`), and a page that tries to frame the site |
| Pipeline's API, or whoever sits in front of it | Every byte of the market list and the trade lists |
| The RPC, or whoever sits in front of it | Every account, balance, blockhash and simulation result the page reads |
| A compromised dependency or build step | The site's own script, so everything |
| A copy of the site on another address | Whatever a visitor believes it is |

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| W1 | Medium | A pool against a worthless token showed its reserves as SOL, on the launch list too | **Fixed**: the site shows and trades only pools against SOL |
| W2 | Medium | Anyone could block a launch between its two transactions | **Fixed**: the pool transaction leaves out what already exists |
| W3 | Low | Token names and symbols could hide or reorder text, and had no length limit | **Fixed**: cleaned, cut and isolated before they are shown |
| W4 | Low | A token's image link makes every visitor's browser call a host of the creator's choice | **Partly fixed**: only public https hosts. Open: decision D1 |
| W5 | Low | The buyer checks missed metadata that wallets read elsewhere, and the two display extensions | **Fixed**: two new checks (covers the site's part of the program review's L3) |
| W6 | Low | The page said "Frozen" whenever it could not read an upgrade authority | **Fixed** |
| W7 | Low | The API could send any number of markets or trades, each costing reads from the chain | **Fixed**: no more than was asked for |
| W8 | Low | Headers: no `Strict-Transport-Security`, an unused WebSocket host in the policy, wallet icons from any address | **Fixed** |
| W9 | Medium | The deploy path trusts every push to `main` and installs an unpinned tool at deploy time | **Partly fixed** in the repository. Open: decision D2 |
| W10 | Medium | The site's address can be taken over by someone else if the workers.dev name ever changes | Open: decision D3 |
| W11 | Low | A token can copy another token's name, symbol and image | Open: decision D4 |
| W12 | Medium | The site trades through whatever program and router are deployed, without noticing an upgrade | Open: decision D5 |
| W13 | Low | A lying RPC can make a quote worse, within what the page shows | Accepted; choose the mainnet RPC with care |
| I1–I4 | Info | Small points | See below |

No finding let anyone move a visitor's SOL or tokens to an address the visitor did not see: every
transaction is built in the browser from addresses the site derives itself, and the program
enforces the rest. W1 and W3–W6 are about what a buyer is shown before they decide, which on a
launchpad is the attack that works. W2 is about availability. W9, W10 and W12 are about who can
change what the site does; they matter little on devnet and a great deal on mainnet.

## Findings

### W1: a pool against a worthless token showed its reserves as SOL

**What:** the program accepts any quote mint. The launch list, the token page and the creator
dashboard showed every verified pool, and printed its quote reserves, market value and unclaimed
tax as SOL. Only the trade panel and the claim refused a pool against another token.

**Impact:** a creator mints a token of their own, uses it as the quote mint and puts a billion
of it in a pool. The launch list then shows that launch with a market value of a billion "SOL",
on the site's own front page, under its own checks ("All checks pass"). Nobody could trade it
from the site, but the page is the advertisement: it sends buyers to trade elsewhere, or lends
the site's name to the token.

**Fix:** `isSolPool` in `app/src/market/pools.ts`: wrapped SOL under the classic token program.
The launch list leaves other pools out and counts them, the token page says the pool is not
against SOL and shows no figures or trade panel, and the dashboard counts them apart.

**Tests:** `are told apart, so their reserves are never shown as SOL` (`view.test.ts`); in
Chromium `lists only pools it can verify against SOL…` and `does not show or trade a pool
against another token, even by its address`.

### W2: anyone could block a launch between its two transactions

**What:** a launch is two transactions: the token, then the pool. The pool transaction always
held the router's `create_market` and both `init_fee_account`s. None of them needs a signature
of the creator's, and each fails if its account already exists. The pool's address follows from
the creator, the token and the tax schedule, all public once the token transaction lands.

**Impact:** someone who watches for the site's token transactions sends `create_market` for
that pool first, for about 0.011 SOL in rent. The creator's pool transaction then fails in the
simulation, and "Create the pool" fails every time after. The token exists with its whole
supply in the creator's wallet and can't be launched from the site. No funds are lost beyond
the token's rent (about 0.005 SOL), and the pool is still the creator's (the program review's
I4), but a bot could stop every launch on the site for a cent each.

**Fix:** `readPoolSetup` (`app/src/launch/chain.ts`) reads which of the three accounts exist,
and `poolInstructions` leaves out the instructions for those. The launch itself is always the
creator's. A pool that is already live stops with a clear message. If the stranger gets in
between the read and the transaction, the transaction fails once and the retry succeeds.

**Tests:** `leaves out the setup someone else already sent, and still launches` and `reads from
the chain what of the setup exists` (`launch.test.ts`); in Chromium `launches although a
stranger created the pool between the two transactions`; on devnet the second test of
`devnet.e2e.test.ts`.

### W3: token names and symbols could hide or reorder text

**What:** the pages showed a token's name and symbol as the mint holds them. React shows them
as text, so markup never ran. But the text itself was unfiltered and unbounded: the launch form
refused only control characters, and a token created outside the site has no rules at all.

**Impact:**
- A right-to-left override (U+202E) displays the text after it backwards, including the page's
  own words on the same line.
- Zero-width characters make two names that look the same differ, or a symbol read as another
  (`SOL` written with a hidden character in it).
- Line breaks, a name of thousands of characters, or stacked combining marks push the page's
  own text out of view.

**Fix:** `displayText` (`app/src/market/view.ts`), applied to every name and symbol before it
is shown: format and unassigned characters go, control characters and every kind of white space
become one space, combining marks are limited to two in a row, and the result is cut to 40
characters (a symbol to 12). The pages wrap names in `<bdi>`, so right-to-left scripts don't
reorder what stands next to them. The launch form refuses a name the pages would show
differently from how it was typed.

**Tests:** `shows a name without the characters that hide or reorder text`, `cuts a long name
or symbol short, by characters`, `reach the page cleaned` (`view.test.ts`); the form cases in
`launch.test.ts`; in Chromium the hostile token of `lists only pools…`.

### W4: a token's image link calls a host of the creator's choice

**What:** the launch list, token page and dashboard load each token's image from the link in
its metadata, from any `https://` address. The policy allows it (`img-src https:`), and no
referrer is sent.

**Impact:**
- **Tracking.** Whoever creates a token learns the IP address and the time of every visit to
  the launch list, where the token appears by itself, and can change the image at any time.
- **Requests into private networks.** A link to `https://192.168.1.1/…` or `https://localhost/…`
  makes the visitor's browser call their own router or computer.
- **A way out for stolen data.** If a dependency were ever compromised, images to any host are
  the one channel the policy leaves open (`connect-src` names two hosts).

The image itself can't run script: it is an `<img>`, and SVG in an `<img>` is inert.

**Fixed now:** `imageUrl` (`app/src/market/view.ts`) accepts only an https address without a
user name, password or port, at most 512 characters, on a public host name: no IP address in
any spelling, no `localhost`, single-label or `.local`/`.internal` names. Anything else shows
the placeholder letter.

**Open, decision D1:** tracking by a public host remains. Options:
1. An image proxy on the site's own domain (a small Worker that fetches, checks type and size,
   and caches). Hides visitors from token creators and lets `img-src` shrink to `'self'`.
   Recommended before mainnet; it is also the natural home for uploads (decision S3).
2. An allowlist of image hosts (for example Arweave and IPFS gateways). No server, but creators
   must use those hosts, and the gateway still sees visitors.
3. Show the image only after a click. No tracking by default, and a plainer list.
4. Accept it, as most launchpads do.

**Tests:** `loads an image only from an https address on a public host` (`view.test.ts`); in
Chromium the hostile token's image is never asked for.

### W5: the buyer checks missed two ways a token can mislead

**What:** "What the chain says" passed a token whose own metadata is fixed while its metadata
pointer names another account (wallets follow the pointer, so they can show another name and
image, which can change), and said "No risky extensions" for `ScaledUiAmount` and
`InterestBearingConfig`, which change the balance a wallet shows (the program review's L3).

**Fix:** "Name and image fixed" now also needs the pointer to have no authority and to point at
the mint itself. A new check, "Balances shown as held", fails for either display extension and
says whether someone can still change it. The site's own amounts are the raw ones the pool
trades on.

**Tests:** `flags metadata that wallets read from somewhere else`, `flags extensions that change
the balance a wallet shows` (`view.test.ts`).

### W6: "Frozen" when the upgrade authority could not be read

The token page said "Frozen: it can never change" for every result without an upgrade
authority, including a program account that could not be read. It now says so only when the
SDK's inspection reports `frozen`, and otherwise that the authority could not be read.

### W7: the API could send any number of entries

`listMarkets` and `getTrades` parsed every entry of a response up to 4 MB. Each market costs
address derivations and reads from the chain, so a hostile or broken API could make every
visitor's browser hammer the RPC. Both now take no more entries than they asked for.
**Test:** `takes no more entries than it asked for` (`api.test.ts`).

### W8: headers and small hardening

- **`Strict-Transport-Security`** was not sent. The workers.dev address doesn't need it (the
  whole `.dev` domain is https-only in browsers), a custom domain will. Now sent, for a year.
  `includeSubDomains` and preloading are choices for when the domain is known. Note that plain
  `http://` still answers with the page on workers.dev; with a custom domain, turn on "Always
  Use HTTPS" in Cloudflare.
- **`connect-src`** allowed `wss://api.devnet.solana.com`, which the site doesn't use. Removed;
  the header test now pins the full list, so a new host is a deliberate change.
- **Wallet icons** were shown from whatever address a wallet gave. Now only `data:image/…`, as
  the Wallet Standard prescribes.

**Tests:** `headers.test.ts`.

### W9: the deploy path

**What:**
- Cloudflare builds and deploys every push to `main`. Whoever can push to `main` (a stolen
  GitHub session or token, a merged pull request nobody read) changes the site within a minute.
  `main` has no branch protection, and GitHub's default branch is still
  `claude/sleepy-faraday-1fldh4`.
- The deploy command is `npx wrangler@4.154.0`. The version is pinned, but `npx` resolves
  wrangler's own dependencies fresh on every deploy, outside our lockfile, and runs them with
  the deploy token.
- CI used actions by tag (`@v4`), which their owners can move, with the default token rights.

**Impact:** on mainnet, a changed site can ask every visitor to sign a transaction that sends
their SOL elsewhere. This is the classic way front-ends are robbed, and no check inside the
site can stop it.

**Fixed in the repository:**
- `app/.npmrc`: dependencies never run install scripts (none of ours needs one).
- CI: read-only token, actions pinned to a commit, `npm audit signatures` (every installed
  package carries the registry's signature), and the browser test.
- The lockfile was checked: 159 packages, all from `registry.npmjs.org`, all with an integrity
  hash; `npm audit` reports no known vulnerability; versions in `package.json` are exact.

**Open, decision D2** (the owner's accounts):
1. Protect `main`: pull requests only, CI must pass, no force pushes. Set the default branch to
   `main`.
2. Two-factor sign-in on GitHub and Cloudflare, and a Cloudflare API token limited to this
   Worker if one is ever needed.
3. Put `wrangler` in `devDependencies`, so the lockfile pins it and its dependencies, and
   deploy with `npx wrangler deploy` from `app`. It adds a few dozen packages to the lockfile
   (not to the site's script). Recommended before mainnet.
4. Before mainnet: deploy only tagged, reviewed commits instead of every push.

### W10: the site's address

**What:** the site lives at `sniper-tax-launch-devnet.majoco21.workers.dev`. `majoco21` is the
account's workers.dev name. If it is ever changed, the old name is free for anyone to register,
and every link to the old address (the README, this repository's history, bookmarks, posts)
then leads to their site.

**Impact:** a ready-made phishing address with our name on it.

**Recommendation, decision D3:** never change the workers.dev name. Before mainnet, move to a
domain of our own (decision S7), state it in the README and the strategy metadata, keep the
domain's registration locked and auto-renewed, and switch workers.dev off for the Worker.

### W11: a token can copy another token

**What:** names and symbols are not unique. Anyone can launch "USD Coin (USDC)" with the real
logo, or a second copy of a popular launch, and it shows on the list like the original. A
symbol can be `SOL`, and the trade panel then reads "You receive about 1,000,000 SOL".

**Impact:** buyers buy the wrong token. The checks on the page are about the token's
mechanics, not about who is behind it.

**Options, decision D4:**
1. A standing line on the token page: names are not unique, check the token's address.
   Cheap, and recommended now.
2. Mark symbols and names of well-known tokens (SOL, USDC, USDT and the like) with a warning.
3. Later: a verified mark for creators who prove who they are. Needs a process and a server.

### W12: upgrades the site doesn't notice

**What:** the site trades through the Pipeline router and our program at fixed addresses. Both
can be upgraded: the router by Pipeline (the program review's L6), ours by the upgrade
authority (M1). The repository pins the router's binary for the tests, but the live site does
not look: after an upgrade it builds the same transactions for different code. The token page
shows our program's last deploy slot, as information only.

**Impact:** an upgrade that changes what a swap does reaches every visitor at once. The
simulation and its spend check catch a swap that takes more SOL than shown, since they run
against the upgraded code, but not every change.

**Options, decision D5:**
1. Before mainnet, the site pins the last deploy slot of both programs and stops trading (with
   a notice) when one differs, until the change is reviewed and the pin is updated. Safe, and
   it means a router upgrade pauses trading on the site until we act.
2. Show a warning instead of stopping.
3. Leave it, and rely on M1's fixes (multisig, timelock or freezing) for our program and on
   Pipeline for theirs.

### W13: a lying RPC

**What it can do:** the page takes reserves, balances and simulation results from the RPC.
An RPC that reports smaller reserves or a higher tax than the truth makes the page quote less
than the trade is worth; the user sees that quote and its minimum, and if they accept, someone
who can order transactions could take the difference. An RPC that fakes a clean simulation
defeats the spend check.

**What it can't do:** change where anything goes. Pool, vault and token account addresses are
derived in the browser; a pool must sit at the address its own fields derive; the treasury a
launch pays is checked by the program. Lies in the other direction (more output, lower tax,
a wrong clock) make the transaction fail on its minimum instead of costing the user. The
wallet shows its own simulation before signing.

**Accepted.** Before mainnet: choose a reputable RPC provider, and note that an RPC key in a
static site is public, so it needs a domain restriction or a small proxy (`LAUNCH-SITE.md`,
section 4).

### I1–I4: info

- **I1:** the launch's state lives in the page. After a reload between the two transactions the
  "Create the pool" button is gone, and the token (whole supply in the creator's wallet) can't
  be launched from the site. Nothing is lost but the token's rent. A later version could offer
  the pool for any token the wallet holds in full.
- **I2:** `require-trusted-types-for 'script'` would make the browser refuse any HTML written
  from a string. The site's own code has no such place (see below), so this is belt and braces;
  it must be tried with real wallet extensions first, since their page scripts run under the
  same rule.
- **I3:** a page error shows an empty page (no error boundary). Not a security matter; a pool
  that makes the page fail would only hide itself.
- **I4:** the review of the site by the Security-Agent repository (`LAUNCH-SITE.md`, section 5)
  has not happened; this document is the self-review that step can start from.

## Checked and found sound

| Attack or risk | Why it does not work | Test |
|---|---|---|
| Script through a token's name, symbol, a log line or an API field | Everything from outside is shown as text. The source has no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `document.write`; the built script has them only inside React | Chromium: `lists only pools…`, `does not ask the wallet when…` (hostile logs) |
| A hostile link | Routes are `#/`, `#/launch`, `#/creator` and `#/pool/<address>`; anything else is "Nothing here". Links out are built from checked addresses and signatures, with `noopener noreferrer` | `route.test.ts` |
| A market the API invents | A pool must be owned by our program, decode as a pool, and sit at the address its own fields derive, with the vaults they derive. The market address must be the one the pool derives | `pools.test.ts`; Chromium: `lists only pools…` (an account of another program, a wrong market address, nonsense) |
| An API that decides what a trade does | The API only says where to look and lists past trades. Quotes, addresses and amounts come from the chain. The site does not use the API's ready-made swap transactions | `api.test.ts`, `trade.test.ts` |
| A transaction that sends funds elsewhere | Each transaction holds only: the signer's own token accounts, the pool's derived accounts, the router and our program. Checked on the bytes the wallet receives | Chromium: `buys…`, `sells…`, `claims…` |
| Signing before knowing the cost | Every transaction is simulated first. It is not sent if the simulation fails, if its cost can't be read, if a buy or a launch costs more than shown, or if a sell or a claim pays less than shown | `trade.test.ts`, `creator.test.ts`, `launch.test.ts`; Chromium: `does not ask the wallet when…` and the last steps of `sells…` and `claims…` |
| A worse price than shown | The router enforces the minimum received, computed from the reserves, the tax two seconds earlier and the chosen slippage (at most 3%) | `trade.test.ts`; devnet tests |
| Claiming someone else's tax, or seeing their pools as yours | The dashboard asks the chain by creator and checks each pool again; the program requires the creator's signature | `creator.test.ts`; Chromium: `claims…` |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | Chromium: `refuses to be framed by another site`; checked live on 11 November |
| Script or data from another host | `script-src 'self'`, `style-src 'self'`, `connect-src` with two hosts, no inline script or style, `object-src 'none'`, `base-uri 'none'`. The pages run without one violation | `headers.test.ts`; every Chromium test |
| Keys or secrets on the site | There are none. Nothing is kept in `localStorage`, cookies or the URL. The mint's key for a launch is made in the browser, signs once and has no power after the mint authority is revoked in the same transaction | `launch.test.ts` |
| A token that can still be minted, frozen or renamed after a site launch | Metadata authority, mint authority and freeze authority are gone in the token transaction itself | `launch.test.ts`, `devnet.e2e.test.ts` |
| The wrong cluster | Transactions carry a devnet blockhash and go to the wallet as `solana:devnet`; they can't land on mainnet | — |
| Files that should not be public | `/_headers`, `/wrangler.jsonc`, `/package.json`, `/.git/config` and `/src/…` are 404 on the live site; no source maps | Checked live on 11 November |
| Known-vulnerable or tampered dependencies | Exact versions, a lockfile with integrity hashes, `npm audit`: 0, registry signatures verified for all 117 installed packages | CI |

## How it was tested

- **Unit tests:** `npm test`, 90 tests (78 before the review).
- **The built site in Chromium, without a network:** `npm run test:browser`, 9 tests in about
  6 seconds, in CI on every push. `test/browser/fake-chain.ts` answers as the devnet RPC and
  Pipeline's API would; `test/browser/site.ts` serves `dist/` with the headers of `_headers` and
  puts a stand-in Wallet Standard wallet in the page, whose signing happens in Node.js, where
  the test reads the transaction. Nine deliberate bugs, one at a time, each made a test fail:
  showing pools against another token (list, and token page), no spend check on a trade or a
  claim, raw names, images from private hosts, framing allowed, ignoring an existing pool, and
  a dashboard that lists other creators' pools.
- **The local build against the real devnet RPC and API in Chromium:** the launch list (nine
  launches) and a token page load without a policy violation or an error, without the WebSocket
  host.
- **On devnet, with real transactions:** `test/devnet.browser.e2e.test.ts` (a launch, a sniper
  buy, a sell and a claim through the pages) and the second test of `test/devnet.e2e.test.ts`
  (W2). Results are in `HANDOFF.md` under "Devnet" once run.

## Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Token images (W4) | Before mainnet: an image proxy on our own domain. On devnet: leave as fixed now |
| D2 | The deploy path (W9) | Now: protect `main`, default branch `main`, two-factor sign-in. Before mainnet: wrangler in the lockfile, deploy reviewed tags only |
| D3 | The site's address (W10) | Never change the workers.dev name; a domain of our own before mainnet |
| D4 | Copied tokens (W11) | Now: a line on the token page that names are not unique. Later: mark well-known symbols |
| D5 | Upgrades (W12) | Before mainnet: pin both programs' deploy slots and stop trading when one changes |

## Recommended order

1. **Done in this review:** W1, W2, W3, W5, W6, W7, W8, and the repository's part of W4 and W9.
2. **Now, by the owner:** D2's first two points and D3's first (no cost, no code).
3. **Before mainnet:** D1, the rest of D2, D3's domain, D4, D5, the choice of RPC (W13), and
   the open points of the program review (M1, M2).
4. **After that:** an external review of the site together with the program's audit.
