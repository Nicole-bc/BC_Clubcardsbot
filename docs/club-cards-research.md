# Club Cards (Bondage Club) — mechanics and API reference

Research notes backing `src/bc-clubcards-bot.user.js`.

**Sources.** Rules/flavour come from the developer's own announcement posts (ben987 / Bondage
Projects). The API details come from **`bc-stubs` v131.0.0** on npm — the TypeScript
declarations the BC developers publish for mod authors. They are generated from the game's
JSDoc, so function names, signatures and field names are authoritative for R131.
`gitgud.io` and the game hosts were unreachable from the machine these notes were written on,
so `ClubCard.js` bodies (and the `ClubCardList` card data) were **not** read directly —
anything marked *(unverified)* below is inference and should be confirmed in a live client.

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

Confirmed by the dev posts:

- Deck = **40 cards, all unique** (no duplicates).
- Both players start with **$10, 0 fame, and the Apartment** (smallest building = level 1).
- The player going first draws **5** cards; the second player draws **6** to compensate.
- Fame goal `X` is configurable (`ClubCardFameGoal`); first to reach it wins.
- Members occupy board slots; **building level caps the member count**.
- Some cards resolve once and are discarded; others stay on the board, and timed **event**
  cards last a number of turns (`Time`, extended by `ExtraTime`).
- Not all cards are unlocked at the start — you win them by beating specific opponents
  (Amanda, Sarah, Sophie, the Maid Quarters maid, the Shibari teacher, …). See
  `ClubCardGetReward()` and `ClubCard.Reward` / `RewardMemberNumber`.

Structural facts from the code:

- A turn ends with exactly one of five actions — `ClubCardStartTurnType`:
  `PlayCard`, `DrawAndEndTurn`, `Bankrupt`, `UpgradeLevel`, `EndTurn`.
  That enum *is* the bot's action space.
- Cards playable per turn: `ClubCardTurnPlayableCardCount(player)` (base + `ExtraPlay`).
- Level-up cost: `ClubCardCalculateLevelCost(player)`; static tables are
  `ClubCardLevelCost[]`, `ClubCardLevelLimit[]` (member cap per level) and
  `ClubCardLiabilityLimit[]`.
- **Liability** cards are played onto the *opponent's* side — `ClubCardIsLiability(card)` and
  `ClubCardFindTarget(card)`.
- **Bankruptcy**: `ClubCardBankrupt()` — "she restarts her club from scratch, draws 5 new
  cards and ends her turn". A legal escape from a board you can no longer pay for.
- Stealing money/fame between players: `ClubCardPlayerSteal(player, money, fame, isStickyFingers)`.
- A card's effect can be capped by its tier: `ClubCardGetMaxEffectFromCard(card, fame)`.
- "Tier 1" is defined in code as **no `RequiredLevel`, or `RequiredLevel <= 1`**
  (see the `ClubCardRandomCardName` doc comment).
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

`ServerAccountUpdate` whitelists `Game.ClubCard`, so writing the object and queueing a
`Game` update persists a deck. The builder also exposes `ClubCardBuilderSaveChanges()`,
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

**Consequence for a bot:** the whole game state lives client-side and is trusted between the
two clients. A bot does not need to fake packets — it drives the normal local functions and
lets the game sync as usual.

## 7. Entry points a bot uses

| Need | Call |
| --- | --- |
| Am I in a game / is it online | `ClubCardIsPlaying()`, `ClubCardIsOnline()` |
| My seat | `ClubCardPlayer[ClubCardGetPlayerIndex()]` |
| Whose turn | `ClubCardPlayer[ClubCardTurnIndex]` |
| Legality | `ClubCardCanPlayCard(me, card)`, `ClubCardCanPlayEffectsLimitation`, `card.CanPlay` |
| Play | `ClubCardPlayCard(me, card, triggerOnPlay)` |
| Targeting prompt | `ClubCardCanSelectCard`, `ClubCardCardsSelectConditions(card, me, AICard)`, `ClubCardSelectCard(card)` |
| Activated ability | `ClubCardCanActiveEffect(me, card)`, `ClubCardActiveEffect(me, card)` |
| Level up | `ClubCardCalculateLevelCost(me)`, `ClubCardUpgradeLevel(me)` |
| End turn | `ClubCardEndTurn(draw)` |
| Give up | `ClubCardConcede()`, `ClubCardBankrupt()` |
| Push state online | `GameClubCardSyncOnlineData("Action")` |
| Built-in AI policy | `ClubCardAIPlay()` / `ClubCardAIStart()` |

`ClubCardAIPlay()` is the game's own opponent policy. It is the cheapest possible "bot", but
it is written for a seat whose `Control === "AI"`; using it for a `"Player"`/`"Online"` seat
is *(unverified)* and may skip the online sync. The script below implements its own policy
and syncs explicitly.

## 8. Open questions to confirm in a live client

1. Numeric values of `ClubCardLevelCost`, `ClubCardLevelLimit`, `ClubCardLiabilityLimit`.
2. Whether `ClubCardPlayCard` already syncs online, or whether `GameClubCardSyncOnlineData`
   must be called after each action.
3. The exact prerequisite/targeting flow (`ClubCardPending` → popup → `ClubCardSelectCard`).
4. The shape of `Player.Game.ClubCard.Reward` (unlocked-card encoding).
5. Whether `ClubCardBuilderList` is populated before the builder screen has been opened once.

`BCC.probe()` in the userscript dumps all five.
