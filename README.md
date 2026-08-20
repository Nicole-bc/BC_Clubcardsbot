# BC_Clubcardsbot

Deck builder and autoplay bot for **Club Cards**, the card minigame inside
[Bondage Club](https://www.bondageprojects.com/club_game/).

**[Deck Lab](https://claude.ai/code/artifact/b52c4c6f-1527-462b-8370-c2ab7c917688)** — an
interactive planner for all 301 cards. Click any card's rules text to see exactly why the
engine values it the way it does, given the deck you have so far.

```
dist/bc-clubcards-bot.user.js   the installable userscript (generated)
dist/deck-planner.html          the Deck Lab page (generated)
src/deck-engine.js              card valuation + deck construction
src/bot.js                      game driving
data/cards.json                 all 301 cards, extracted from ClubCard.js R131
tools/build-deck.js             build and inspect decks offline
tools/verify-deck.js            check a deck against a real ClubCard.js
docs/club-cards-research.md     how Club Cards actually works
```

## It does not change how the game plays

The script hooks nothing and patches nothing. It reads game state and calls the same entry
points a mouse click calls — `ClubCardStartTurn`, `ClubCardSelectCard`, `ClubCardActiveEffect`
— so every card effect runs the game's own untouched code. It also adds no network sync of
its own, because the vanilla client only syncs on upgrade, end of turn and end of game;
adding more would leak board state the opponent is not meant to see mid-turn.

## Install

1. Install Tampermonkey.
2. Create a new script and paste `dist/bc-clubcards-bot.user.js`.
3. Load the game and open the browser console.

## Use

```js
BCC.probe()               // live state: pool size, tables, seat, whose turn
BCC.slots()               // what is in each of your 10 deck slots
BCC.build()               // build a deck and print it (never saves)
BCC.config.dryRun = false // required before anything is written or played
BCC.save()                // write to the first empty slot
BCC.save(3)               // or a specific one
BCC.saveIds([...], 3)     // save a deck planned in the Deck Lab
BCC.start()               // autoplay
BCC.stop()
```

Two guards are on by default: `dryRun` narrates every decision without acting, and
`allowOnline` refuses to act in a game against another player. Start with a practice game
against the Lounge tutor, watch the console with `dryRun` on, then turn it off.

Unlocking the 23 reward cards (normally won off specific NPCs) — this writes to your
account on the server, so keep the backup string it returns:

```js
BCC.config.dryRun = false
const backup = BCC.unlockAll()   // adds all reward cards to the builder
BCC.restoreUnlocks(backup)       // puts it back
```

Offline, without the game running:

```
npm run deck                      # best deck over the base card pool
npm run deck -- --archetype Maid  # force a tribal build
npm run deck -- --owned 1234,5678 # include reward cards you have unlocked
npm run archetypes                # score every archetype against each other
npm run bundle                    # regenerate the userscript after editing src/
npm run planner                   # regenerate the Deck Lab page
```

## How the deck is built

The engine parses each card's rules text into per-turn clauses (`+3 Fame/turn per Patient
ally (max +12)`), conditional clauses (`if there's a Dominant ally`), one-shot entry effects,
draws and extra actions, then values them **against the deck being built** — so a card that
pays off per Maid is only worth what your Maid density says it is. It builds a candidate for
every archetype the deck builder itself recognises, refines each one three times, and keeps
the highest total. Fame is weighted as the win condition; money at roughly 0.4 of a fame
point, since it only buys tiers and covers upkeep.

`docs/club-cards-research.md` §8 lists where the model is known to be wrong.

## How it plays

Each action it takes the best single option: answer any open popup, resolve a pending target,
then choose between playing the highest-valued legal card, using an activated ability
(which costs an action, so it competes), upgrading the club, or drawing and passing. Two rules
shape the scoring — a turn ending with negative money erases that turn's fame gain, and a
liability is worthless once the opponent's liability slots are full.

## Fair play

Pointing this at someone who doesn't know they're playing a script is a fairness problem,
which is why online play is off by default. If you do play a human, tell them.
