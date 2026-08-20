# BC_Clubcardsbot

A userscript for the **Club Cards** minigame inside [Bondage Club](https://www.bondageprojects.com/club_game/):
it builds a deck from your unlocked card pool and can play a game on its own.

- `src/bc-clubcards-bot.user.js` — the script (Tampermonkey/Violentmonkey).
- `docs/club-cards-research.md` — how Club Cards works: rules, card model, turn actions,
  persistence, and the online packet protocol.

## Status

Early scaffold. The deck builder and the turn policy are implemented and syntax-clean, but
they have **not been run against a live client yet**. The research was done from the
official `bc-stubs` v131 type definitions (published to npm by the BC developers), which pin
down every function signature and field name but contain no card *data* — so the deck builder
scores the live `ClubCardList` at runtime rather than using a hardcoded meta list.

Both risky defaults are off: `dryRun` decides and logs without acting, and `allowOnline`
refuses to act in a game against another human.

## Install

1. Install Tampermonkey.
2. Create a new script and paste `src/bc-clubcards-bot.user.js`.
3. Load the game, open the browser console.

## Use

```js
BCC.probe()              // dump the live API surface, card pool and level tables
BCC.build()              // compute a deck and print it as a table (never saves)
BCC.config.dryRun = false
BCC.save(0)              // write the deck into deck slot 0 and sync to the server
BCC.start()              // autoplay (still dryRun-guarded until you turn it off)
BCC.stop()
```

Sensible first run: `BCC.probe()`, then `BCC.build()` to see what it picked, then
`BCC.start()` with `dryRun = true` during a practice game in the Club Card Lounge and read
the console — it narrates every decision it *would* make. Only then turn `dryRun` off.

## How the deck is built

1. **Pool** — `ClubCardBuilderList` if the builder has been opened, else `ClubCardList`
   filtered against the reward cards you own.
2. **Archetype** — the group tag (Maid, Latex, Asylum, Dominant / Mistress, …) with the
   deepest, strongest pool on your account.
3. **Score** — fame and money per turn, extra plays and extra event time, activated
   abilities and special effects, minus a tier penalty and a penalty for conditional
   (`Prerequisite`) cards, plus a synergy bonus for the archetype.
4. **Curve** — quotas per tier (16/12/8/4 by default), topped up with the best leftovers to
   the 40-card limit. All weights and quotas live in `BCC.config`.

## How it plays

Each turn it takes the single best action available, in this order: resolve a pending target
selection, use an activated ability on the board, play the highest-scoring legal card while
plays remain, upgrade the building when the club is full and the money is there, otherwise
draw and pass. Actions are spaced by a randomised delay.

## Fair play

Running this against another player who doesn't know they're facing a script is a fairness
problem, which is why online play is off by default. Practice games against the Lounge tutor
and NPC opponents are the intended use; if you do point it at a human, tell them.
