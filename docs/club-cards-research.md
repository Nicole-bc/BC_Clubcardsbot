# Club Cards (Bondage Club) — mechanics and API reference

Research notes backing `src/bc-clubcards-bot.user.js`.

**Sources.** Everything below is read from the game's own source: `ClubCard.js`,
`ClubCardBuilder.js`, `GameClubCard.js`, `ClubCardLounge.js` and `Text_ClubCard.csv` (R131),
cross-checked against the `bc-stubs` v131 type declarations. The card data in
`data/cards.json` was extracted by evaluating `ClubCard.js` and joining the caption file —
301 cards, verified card-for-card against the live `ClubCardList`.

---

## 1. What the game is

Club Cards is a two-player deckbuilding minigame embedded in Bondage Club. Each player runs a
BDSM club: you play **members** into your club, they generate **money** and **fame** every
turn, and the first club to reach the fame goal wins.

Where it lives in the client:

| Screen | Module | Purpose |
| --- | --- | --- |
| `ClubCardLounge` | `Screens/Room/ClubCardLounge` | The room; has a tutor NPC and a practice game (`ClubCardLoungePraticeGameStart`) |
| `ClubCardBuilder` | `Screens/MiniGame/ClubCardBuilder` | Deck editor (filters, precons, deck slots, card backs) |
| `ClubCard` | `Screens/MiniGame/ClubCard` | The game board itself |
| `GameClubCard` | `Screens/Online/GameClubCard` | Online wrapper: lobby, player slots, packet sync |

Chat-room games are an online game mode like LARP or Magic Battle: room admin sets the game,
two members take player slots, everyone else can spectate.

## 2. Rules

- Deck = **30 to 40 cards, all unique** (`ClubCardBuilderMinDeckSize` / `MaxDeckSize`). Ten
  deck slots per account. The dev posts say 40; 30 is the real floor.
- **First to 100 fame wins** — `ClubCardFameGoal = 100`, not configurable in R131.
- The player going first draws **5** cards, the second **6**. Both also start with a free
  **Tips** card in hand (`ClubCardLoadDeckNumber`).
- Club tiers, straight from `Text_ClubCard.csv` and the tables:

  | Tier | Building | Cost | Member slots | Liability slots |
  | --- | --- | --- | --- | --- |
  | 1 | Apartment | free | 5 | 1 |
  | 2 | Cottage | 10 | 7 | 2 |
  | 3 | House | 20 | 13 | 3 |
  | 4 | Mansion | 30 | 20 | 5 |
  | 5 | Manor | 40 | 40 | 8 |

  `ClubCardLevelLimit = [0,5,7,13,20,40]`, `ClubCardLevelCost = [0,0,10,20,30,40]`,
  `ClubCardLiabilityLimit = [0,1,2,3,5,8]` — all indexed by tier, so index 0 is unused.
  Quality Maid cuts the upgrade cost by 10 each; Inspector raises it by 10.
- **Ending a turn with negative money cancels that turn's fame gain.** `ClubCardEndTurn`
  restores `Fame` to its value at the start of the turn if `Money < 0`. This is the single
  most important rule for a bot: over-committing on upkeep does not just slow you down, it
  erases the turn.
- Events without the `TimedEvent` or `ContinuousEvent` group are discarded at the end of the
  turn they were played.
- Not all cards are unlocked at the start — you win them by beating specific opponents. See
  `ClubCardGetReward()` and `ClubCard.Reward` / `RewardMemberNumber`; 23 of the 301 cards are
  reward cards.

Structural facts from the code:

- A turn ends with exactly one of five actions — `ClubCardStartTurnType`:
  `PlayCard`, `DrawAndEndTurn`, `Bankrupt`, `UpgradeLevel`, `EndTurn`.
  That enum *is* the bot's action space.
- Cards playable per turn: `ClubCardTurnPlayableCardCount(player)` (base + `ExtraPlay`).
- Level-up cost: `ClubCardCalculateLevelCost(player)`, and `Homeroom` blocks upgrades for
  both players while it is out.
- **Liability** cards are played onto the *opponent's* side — `ClubCardIsLiability(card)` and
  `ClubCardFindTarget(card)`.
- **Bankruptcy**: `ClubCardBankrupt()` — "she restarts her club from scratch, draws 5 new
  cards and ends her turn". A legal escape from a board you can no longer pay for.
- Stealing money/fame between players: `ClubCardPlayerSteal(player, money, fame, isStickyFingers)`.
- A card's effect can be capped by its tier: `ClubCardGetMaxEffectFromCard(card, fame)`.
- "Tier 1" is defined in code as **no `RequiredLevel`, or `RequiredLevel <= 1`**.
- Card counts by tier across the 301 cards: 113 / 61 / 61 / 44 / 22. 209 members, 92 events.
- Cards can be **negated** (`Negated`, `Negating`, `ClubCardCancelNegation`).
- Several cards have bespoke handlers: Alvin (`ClubCardAlvinCondition`), Tifa
  (`ClubCardTifaSelection`), Clare (`ClubCardClareSelection`), plus a "Streets" zone
  (`StreetsTurnEnd`, and `source: 'Streets'` in `ClubCardPlayerSummonGroupCardFromDeck`).

## 3. The card model

```ts
interface ClubCard {
  ID: number;  UniqueID?: string;  Name: string;  ArrayIndex?: number;
  Type?: string;                 // member type
  Title?: string;  Text?: string; // display
  Prerequisite?: string;         // requires another card / condition
  Reward?: string;               // unlock source
  RewardMemberNumber?: number;
  MoneyPerTurn?: number;         // income while on board
  FamePerTurn?: number;          // fame while on board
  RequiredLevel?: number;        // building level needed = "tier"
  Time?: number;                 // event duration in turns
  ExtraTime?: number;            // extends other events
  ExtraPlay?: number;            // extra cards playable per turn
  Group?: string[];              // archetype tags
  Location?: string;
  Negated?: boolean;  Negating?: string;
  EffectKey?: number; EffectType?: string;
  Revealed?: boolean; CanActive?: boolean;   // has an activatable ability
  // + glow/animation render state
}
```

Every card may declare hooks, all `(C: ClubCardPlayer) => void` unless noted:

`OnPlay`, `CanPlay → boolean`, `OnGameStart`, `WhenDrawn`, `OnActive`, `turnStart`,
`BeforeTurnEnd`, `AfterTurnEnd`, `BeforeOpponentTurnEnd`, `AfterOpponentTurnEnd`,
`onPlayedCard(C, Card)`, `onOpponentPlayedCard(C, Card)`, `onLeaveClub`,
`onMemberLeaveClub(C, Card, DidntDiscard)`, `onDiscardCard(C, Card)`, `onLevelUp`,
`onOpponentLevelUp`, `onDrawCard`, `onOpponentDrawCard`, `onDrawAction`,
`onOpponentDrawAction`, `onSteal`, `onCancelNegation`, `StreetsTurnEnd`, `onRender`.

Ordering matters and is documented on `ClubCardList`:

> The `BeforeTurnEnd` hooks are run **before** regular fame and money are calculated and are a
> good place to remove cards so they don't add fame/money that turn. The `AfterTurnEnd` hooks
> run after this, and can be used to adjust the total amount of money / fame gained that turn.

### Card tags (deck-builder filters)

`All Cards`, `Selected Cards`, `Event Cards`, `Ungrouped`, `Liability`, `Staff`, `Police`,
`Criminal`, `Fetishist`, `Porn`, `Maid`, `Asylum`, `Dominant / Mistress`, `ABDL`, `College`,
`Shibari`, `Pet / Owner`, `Kemonomimi`, `Submissive / Slave`, `Exhibitionist`, `Latex`,
`Online Player`, `Reward Cards`.

These double as the archetype axis: the bot picks the tag with the deepest available pool and
builds around it.

## 4. Player / game state

```ts
interface ClubCardPlayer {
  Character: Character;
  Control: "AI" | "Player" | "Online";
  Index: number;  Sleeve: number;
  Deck: ClubCard[];  FullDeck: ClubCard[];  Hand: ClubCard[];
  Board: ClubCard[]; Event: ClubCard[];  RenderFullBoard: ClubCard[];  DiscardPile: ClubCard[];
  Level: number;  Money: number;  Fame: number;
  LastFamePerTurn?: number;  LastMoneyPerTurn?: number;
  ClubCardTurnCounter: number;
  CardsPlayedThisTurn: Record<number, ClubCard[]>;
}
```

Globals worth knowing: `ClubCardPlayer[]` (both seats), `ClubCardTurnIndex`,
`ClubCardTurnCardPlayed`, `ClubCardFameGoal`, `ClubCardGameEnded`, `ClubCardList` (all card
definitions), `ClubCardFocus` / `ClubCardPending` / `ClubCardSelection` (UI selection state),
`ClubCardPopup` (prompt state), `ClubCardLog` / `ClubCardRenderLog` (message log).

## 5. Persistence

Decks live on the character, synced to the server as `Player.Game.ClubCard`:

```ts
interface GameClubCardParameters {
  Deck: string[];        // one entry per deck slot; card IDs
  DeckName?: string[];
  Reward?: string;       // unlocked reward cards
  Status?: "" | "Running";
  PlayerSlot?: number;
  Background?: string;
  CardBack?: number;
  Settings?: { AutoSpectate?: boolean; IsAnimation?: boolean };
}
```

**A deck is stored as a string of characters whose code points are the card IDs** — see
`ClubCardBuilderSaveChanges`:

```js
for (let C of ClubCardBuilderDeckCurrent) Deck = Deck + String.fromCharCode(C);
```

and it is read back with `charCodeAt(i)`. So `deck.length` *is* the card count, which is
what the 30-40 validity check measures. `Player.Game.ClubCard.Reward` uses the same
encoding: a card is unlocked when `Reward.indexOf(String.fromCharCode(card.ID)) >= 0`.
Card IDs run 1000-31046, all outside the UTF-16 surrogate range, so the round trip is safe.

`ServerAccountUpdate.QueueData({ Game: Player.Game }, true)` persists it. The builder also exposes `ClubCardBuilderSaveChanges()`,
`ClubCardBuilderLoadDeck(n)`, `ClubCardBuilderMinDeckSize` / `MaxDeckSize`,
`ClubCardBuilderList` (the legal card pool for this account) and
`ClubCardBuilderDefaultDecksList` — the precons `Default`, `Princess Treatment`,
`Permanent Stay`, `Pound Town`, plus themed starters (`ClubCardBuilderMaidDeck`,
`…DominantDeck`, `…PornDeck`, `…AsylumDeck`, `…ABDLDeck`, `…CollegeDeck`, `…LiabilityDeck`).

## 6. Online protocol

Packets ride the chat-room game channel (`GameProgress`):

```ts
{ GameProgress: "Start", Player1: number, Player2: number }
{ GameProgress: "Query" }                                            // request state
{ GameProgress: "Query", CCData: ServerChatRoomGameCardGameData[], Player1, Player2 }
{ GameProgress: "Action", CCData?: ..., CCLog?: ClubCardMessage }    // a move
```

Per-seat payload:

```ts
interface ServerChatRoomGameCardGameData {
  MemberNumber: number; Playing: boolean;
  Level: number; Fame: number; Money: number;
  LastFamePerTurn: number; LastMoneyPerTurn: number;
  FullDeck: string; Deck: string; Hand: string; Board: string; Event: string; DiscardPile: string;
  CardsPlayedThisTurn: Record<number, ClubCard[]>;
  ClubCardTurnCounter: number; Sleeve: number;
}
```

Zones travel as bundled strings: `GameClubCardDoBundle`, `GameClubCardBoardDoBundle`,
`GameClubCardHandDoBundle` and the matching `…UndoBundle`. Outbound sync is
`GameClubCardSyncOnlineData(Progress?, LocalPlayerOnly?)`; inbound is `GameClubCardProcess`.

**Sync happens in exactly four places** — `ClubCardUpgradeLevel`, `ClubCardLoadDeckNumber`
(local player only), `ClubCardEndTurn` and `ClubCardEndGameSyncAndMessage`. Playing a card
mid-turn is *not* synced: the opponent sees your board when your turn ends. A bot must
therefore not add sync calls of its own — doing so would show the opponent information the
vanilla client would not.

The whole game state lives client-side and is trusted between the two clients, so a bot never
needs to forge packets — it drives the normal local functions and lets the game sync as usual.

## 7. Driving the game

Every turn ends in one of five actions, and all of them go through `ClubCardStartTurn`:

```js
ClubCardStartTurn(ClubCardStartTurnType.PLAYCARD)      // plays ClubCardFocus
ClubCardStartTurn(ClubCardStartTurnType.DRAWENDTURN)   // draws if no card was played, ends turn
ClubCardStartTurn(ClubCardStartTurnType.UPGRADELEVEL)
ClubCardStartTurn(ClubCardStartTurnType.BANKRUPT)      // fresh club, redraw 5, end turn
ClubCardStartTurn(ClubCardStartTurnType.ENDTURN)       // no-op branch
```

`ClubCardClickPlayCard(false)` is just `ClubCardStartTurn(PLAYCARD)`, so setting
`ClubCardFocus` and calling that is precisely the mouse path.

Targeting: if a card has a `Prerequisite`, `ClubCardPlayCard` parks it in `ClubCardPending`
and returns without spending the action. Pick a target where
`ClubCardCanSelectCard(me, card)` is true, then call `ClubCardSelectCard(target)` — that sets
`ClubCardSelection` and re-enters `ClubCardPlayCard`. Prerequisite kinds: `SelectOwnMember`,
`SelectOpponentMember`, `SelectAnyMember`, `SelectAnyEvent`, `SelectCardInHand`,
`SelectATier` (opens the `TIERSELECTION` popup), `SearchACard` (opens the `SEARCH` popup).

Popups (`ClubCardPopup.Mode`): `DECK` (pick a deck slot at game start via
`ClubCardLoadDeckNumber(n)`), `TEXT`, `YESNO`, `SEARCH`, `TIERSELECTION`, `DISCARDPILE`,
`INFO`.

| Need | Call |
| --- | --- |
| Am I in a game / online | `ClubCardIsPlaying()`, `ClubCardIsOnline()` |
| My seat | `ClubCardPlayer[ClubCardGetPlayerIndex()]` |
| Whose turn | `ClubCardPlayer[ClubCardTurnIndex]` |
| Legality | `ClubCardCanPlayCard(me, card)` — needs `card.Location === "PlayerHand"` |
| Plays remaining | `ClubCardTurnPlayableCardCount(me) - ClubCardTurnCardPlayed` |
| Activated ability | `ClubCardCanActiveEffect(me, card)`, `ClubCardActiveEffect(me, card)` — **costs an action** |
| Give up | `ClubCardConcede()` |

`ClubCardAIPlay()` is the game's own opponent policy: 50/50 upgrade if affordable, otherwise
play a **random** legal card, otherwise consider bankruptcy, otherwise draw and pass. It bails
out immediately unless `Control === "AI"`, so it cannot drive a human seat — and beating it is
a low bar.

## 8. Tempo — how the game is actually played

The rules above come from the source. This section comes from play experience, and it changes
the valuation more than any single rule does:

- **Games run 15-17 turns and rarely reach 20.** Players push for a fast, aggressive win.
- 100 fame in ~16 turns means a deck must average better than **6.25 fame per turn**.
- **Most players run 30 cards, not 40.** You draw one card per turn and the format is
  singleton, so a 30-card deck reaches any particular card about a third sooner. When a deck
  depends on specific win-condition cards, the minimum size is the correct size.
- **A card only earns for the turns left after you can afford it.** Climbing to tier 5 costs
  100 money in total, so tier 5 cards land around turn 12 and pay out for about four turns,
  while a tier 1 card pays out for fifteen:

  | Tier | Comes online | Turns of payout |
  | --- | --- | --- |
  | 1 | turn 1 | 15 |
  | 2 | turn 3 | 13 |
  | 3 | turn 6 | 10 |
  | 4 | turn 9 | 7 |
  | 5 | turn 12 | 4 |

  The engine uses exactly this table (`TIER_ONLINE`, `tierLifetime`). An expensive card has to
  be dramatically better than a cheap one, not slightly better, and a deck that only comes
  together at tier 4 has already lost to one that curved out at tier 2. The default curve
  (`CURVE`) is weighted low to match: 14/10/8/5/3, normalised to the deck size.

## 9. Modelling notes

`data/cards.json` carries each card's static `FamePerTurn` / `MoneyPerTurn`, but most of a
card's power sits in its rules text and hooks, which the static fields do not express. The
deck engine parses the text for per-turn clauses (`+2 Fame/turn per Patient ally (max +8)`),
conditional clauses (`if there's a Dominant ally`), one-shot entry effects, draws and extra
actions, then values them against the composition of the deck being built.

Known limits of that model, all of which under- or over-rate specific cards:

- Drawback text is not parsed. `Encased` ("You Play A Non-Latex Non-Dominant Member: Leaves")
  scores on its raw 2/6 statline as if the drawback did not exist.
- Effects with no digits ("+Fame/turn equal to club tier") are scored at a flat tier 3.
- Conditional one-shots are discounted by a flat half rather than by real probability.
- Cards whose value is entirely in a hook the text does not quantify are scored near zero.

The archetype search is honest about the result: with the full card pool unlocked, a generic
"best cards" deck currently out-scores every tribal build, because tribal payoffs are capped
while generic statlines are not. `node tools/build-deck.js --all` prints the comparison.
