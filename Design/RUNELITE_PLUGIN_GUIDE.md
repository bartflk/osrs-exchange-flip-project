# RuneLite GE-capture plugin — how it works, and how not to get banned

Written in response to a direct question: *"can you actually read the GE slots from a plugin? if not, build a plugin then. I will need a tutorial on how to actually do the whole process of not getting banned for making something stupid."*

Short answers:

1. **Yes, a plugin can read your GE slots** — it's a first-class RuneLite API, not a hack.
2. **You don't need a plugin to start.** Flipping Copilot already writes your live slot state to disk, and this app reads it today. The plugin matters for *independence*, not access.
3. **The account risk here is close to zero, and the reason is structural**, not luck — see [The safety line](#the-safety-line).

---

## 1. Two ways to get the data

### (a) Read another plugin's files — works right now, zero risk

Flipping Copilot writes one JSON file per GE slot to `~/.runelite/flipping-copilot/`:

```
acc_<accountHash>_0.json  …  acc_<accountHash>_7.json
```

```json
{"itemId":1603,"quantitySold":7571,"totalQuantity":11286,"price":827,
 "spent":6261217,"state":"BUYING","copilotPriceUsed":true,"wasCopilotSuggestion":true}
```

This is just a file on your disk. Reading it is not a game interaction at all — the game client isn't involved, so there is no rule that could apply. Nothing to approve, nothing to install.

**The catch:** you're depending on someone else's plugin staying installed and not changing its format. It's a fine bootstrap, a poor foundation.

Flipping Utilities (`~/.runelite/flipping/<account>.json`) additionally keeps a full local *history* — every offer event with price, quantity, timestamp and state. Copilot does not; its history lives on their servers, and locally it keeps only a transient `un_acked.jsonl` buffer that clears once uploaded.

### (b) Write our own plugin — the durable answer

RuneLite fires an event every time any GE slot changes. That's the whole mechanism:

```java
@Subscribe
public void onGrandExchangeOfferChanged(GrandExchangeOfferChanged event)
{
    int slot = event.getSlot();          // 0-7
    GrandExchangeOffer offer = event.getOffer();
    // offer.getItemId(), getPrice(), getTotalQuantity(),
    // getQuantitySold(), getSpent(), getState()
}
```

Those six getters are the complete `GrandExchangeOffer` interface — verified against
[the source](https://github.com/runelite/runelite/blob/master/runelite-api/src/main/java/net/runelite/api/GrandExchangeOffer.java).
Note they map 1:1 onto the fields in Copilot's files above, which is how we know that's exactly what it's doing.

`getState()` returns a `GrandExchangeOfferState`: `EMPTY`, `BUYING`, `BOUGHT`, `CANCELLED_BUY`, `SELLING`, `SOLD`, `CANCELLED_SELL` — the same vocabulary Flipping Utilities stores in its `st` field.

The plugin's entire job is: on each event, POST a small JSON body to `http://localhost:3001/api/ge-offer`. It renders nothing, changes nothing, and sends nothing to the game.

---

## 2. The safety line

**The rules are about what a client makes *happen*, not what it lets you *see* about your own account.**

RuneLite is one of only two clients on Jagex's Approved Client List (with HDOS), so running it is explicitly fine. What the [Third Party Client Guidelines](https://oldschool.runescape.wiki/w/Update:Third_Party_Client_Guidelines) actually prohibit clusters into two groups:

**Actions sent to the server**
- "Any addition of new menu entries which cause actions to be sent to the server"
- Any movement or resizing of click zones
- Autoclickers and input automation — a permanent ban if detected, on *any* client including Jagex's own

**Combat advantage**
- Next-attack prediction (timing or style)
- Projectile targets, impact locations
- Prayer-switching indicators
- Anything that tells you where to stand in a boss fight

Read that list and notice what isn't on it. The guidelines contain **no restriction on Grand Exchange data, trade history, or profit tracking.** That isn't an oversight to exploit — it's because the concern is combat integrity and automation, and reading back your own completed trades is neither.

The strongest evidence is precedent: **Flipping Utilities, Flipping Copilot, and Exchange Logger all do exactly this and are on the official Plugin Hub**, which exists specifically to vet plugins against these rules. You're already running two of them.

### Where this app already sits

DESIGN.md §1/§3 committed from the start to read-only, no automation, "never generates or submits anything." A plugin that listens to offer events and POSTs to localhost doesn't move that line — it's the same posture, better plumbed. The app tells you things; you do them.

### Things that would actually put an account at risk

Do not, under any circumstances, add:

- **Anything that sends input** — no `Robot`, no synthetic clicks or keypresses, no "auto-place this offer," no "auto-collect," no "auto-relist." This is the bright line. Everything else is detail.
- **Menu manipulation** that injects entries causing server actions.
- **Reflection or bytecode injection** to reach data the client doesn't expose. If it needs a hack to read, don't read it.
- **Playing while unattended** on anything driven by the plugin.

The rule of thumb that keeps you safe: **the plugin may observe and report; only you may act.** If a feature request ever starts with "could it just automatically…", the answer is no.

> Caveat worth stating plainly: I'm summarising published guidelines, not speaking for Jagex, and rules change. The links above are authoritative; this document isn't. If you ever add something that feels borderline, check the guidelines rather than this file.

---

## 3. Building and running it

### Sideloading vs. the Plugin Hub

You do **not** need to publish this. The Plugin Hub is for *distributing* plugins to other people; the review process exists for their protection, not as permission to run your own code. For a personal plugin, sideloading is the normal path and skips submission entirely.

The Plugin Hub's own standard is "if it is difficult for us to ensure the plugin isn't against the rules we will not merge it" — a distribution bar, not a legality bar.

### Setup

1. Start from the official template: [runelite/example-plugin](https://github.com/runelite/example-plugin) — a Gradle project with the RuneLite dependency already wired up.
2. Implement `onGrandExchangeOfferChanged` as above.
3. POST to `http://localhost:3001/api/ge-offer` — fire-and-forget, wrapped in try/catch, and **never blocking the game thread** (use RuneLite's injected `ScheduledExecutorService`, or `OkHttpClient`'s async `enqueue`). A plugin that blocks on a dead socket will freeze the client.
4. `./gradlew build`, then run the client with the plugin on the classpath — the template's README covers running RuneLite from your IDE with the plugin loaded.

### Deliberate design constraints for our plugin

- **No UI.** No overlay, no panel, no sidebar. Less surface, less to review, nothing to interfere with gameplay.
- **localhost only.** Never send game data off the machine. This matches the app's local-only goal (DESIGN.md §1) and sidesteps every data-handling question at once.
- **Degrade silently.** If the backend is down, drop the event. The game client must never notice.
- **Include the account hash**, not the username, so multi-account stays separable without storing an identity.

---

## 4. Why the backend still diffs slot state

Even with the plugin, the backend keeps deriving transactions by diffing slot snapshots on its existing 60s poll (see DESIGN.md §14.40). That is deliberate redundancy:

- It works **today**, before the plugin exists.
- It keeps working if the plugin is uninstalled, RuneLite is updated, or you're playing on another machine.
- It's the same "additive, not load-bearing" principle applied to Reddit ingestion (§14.35) — a second source that fails independently.

A rising `quantitySold` on a slot **is** a fill; that's a deterministic fact about the data, not an inference. The plugin makes capture instant and exact rather than 60s-granular; it doesn't make it possible.

---

## Sources

- [GrandExchangeOffer.java](https://github.com/runelite/runelite/blob/master/runelite-api/src/main/java/net/runelite/api/GrandExchangeOffer.java) — the six-method API, verified directly
- [Update:Third Party Client Guidelines — OSRS Wiki](https://oldschool.runescape.wiki/w/Update:Third_Party_Client_Guidelines) — the actual prohibitions
- [Third Party Clients Update — Jagex](https://secure.runescape.com/m=news/third-party-clients-update?oldschool=1) — the Approved Client List announcement
- [RuneLite — OSRS Wiki](https://oldschool.runescape.wiki/w/RuneLite) — approved-client status
- [runelite/plugin-hub](https://github.com/runelite/plugin-hub) — submission process and review standard
- [runelite/example-plugin](https://github.com/runelite/example-plugin) — the project template
