import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const suits = ["♠", "♥", "♦", "♣"];

const TEAM_1_SEATS = [0, 2, 4];
const TEAM_2_SEATS = [1, 3, 5];

const BOT_DELAY = 2200;
const BOT_DECISION_DELAY = 1600;

/* 20 SECUNDE */
const TURN_TIME = 20000;

const ALLOWED_EMOJIS = [
  "😂",
  "❤️",
  "😡",
  "😭",
  "👍",
  "👎",
  "🔥",
  "👏"
];

const REPORT_REASONS = [
  "A spus ce cărți are",
  "I-a spus colegului ce să joace",
  "A coordonat jocul prin voce",
  "Altă trișare"
];

/* =========================
   HELPERS
========================= */

function teamForSeat(seat) {
  return seat % 2 === 0 ? 1 : 2;
}

function otherTeam(team) {
  return team === 1 ? 2 : 1;
}

function seatsForTeam(team) {
  return team === 1
    ? TEAM_1_SEATS
    : TEAM_2_SEATS;
}

function firstFreeSeatForTeam(room, team) {
  for (const seat of seatsForTeam(team)) {
    if (!room.players[seat]) {
      return seat;
    }
  }

  return -1;
}

function teamCount(room, team) {
  return seatsForTeam(team).filter(
    seat => room.players[seat]
  ).length;
}

function playerCount(room) {
  return room.players.filter(Boolean).length;
}

function teamsAreValid(room) {
  return (
    teamCount(room, 1) === 3 &&
    teamCount(room, 2) === 3
  );
}

function firstHumanPlayer(room) {
  return room.players.find(
    p => p && !p.bot && p.connected
  );
}

function nextSeat(seat) {
  return (seat + 1) % 6;
}

function shuffle(array) {
  for (
    let i = array.length - 1;
    i > 0;
    i--
  ) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [
      array[i],
      array[j]
    ] = [
      array[j],
      array[i]
    ];
  }
}

/* =========================
   DECK
========================= */

function makeDeck() {
  const deck = [];

  /* 4 șeptari */
  for (const suit of suits) {
    deck.push({
      rank: "7",
      suit
    });
  }

  /* doar 2 optari */
  const eightSuits = [...suits];

  shuffle(eightSuits);

  deck.push({
    rank: "8",
    suit: eightSuits[0]
  });

  deck.push({
    rank: "8",
    suit: eightSuits[1]
  });

  for (
    const rank of [
      "9",
      "10",
      "J",
      "Q",
      "K",
      "A"
    ]
  ) {
    for (const suit of suits) {
      deck.push({
        rank,
        suit
      });
    }
  }

  shuffle(deck);

  return deck;
}

function isPoint(card) {
  return (
    card.rank === "10" ||
    card.rank === "A"
  );
}

function isCut(card, openingRank) {
  return (
    card.rank === "7" ||
    card.rank === "8" ||
    card.rank === openingRank
  );
}

function countPoints(table) {
  return table.reduce(
    (sum, play) =>
      sum + (
        isPoint(play.card)
          ? 1
          : 0
      ),
    0
  );
}

/* =========================
   ROOM
========================= */

function createRoomCode() {
  let code;

  do {
    code = String(
      Math.floor(
        100000 +
        Math.random() * 900000
      )
    );
  } while (rooms.has(code));

  return code;
}

/* =========================
   STATE
========================= */

function publicState(room) {
  return {
    hostId: room.hostId,

    started: room.started,
    gameFinished: room.gameFinished,
    gameId: room.gameId,

    players: room.players.map(
      (player, seat) => {

        if (!player) {
          return null;
        }

        return {
          name: player.name,
          team: teamForSeat(seat),
          bot: !!player.bot,
          connected: player.connected,

          voiceEnabled:
            !!player.voiceEnabled,

          speaking:
            !!player.speaking
        };
      }
    ),

    handCounts:
      room.hands.map(
        hand => hand.length
      ),

    matchScore1:
      room.matchScore1,

    matchScore2:
      room.matchScore2,

    cardPoints1:
      room.cardPoints1,

    cardPoints2:
      room.cardPoints2,

    piles1:
      room.piles1,

    piles2:
      room.piles2,

    roundNumber:
      room.roundNumber,

    turn:
      room.turn,

    opener:
      room.opener,

    openingRank:
      room.openingRank,

    table:
      room.table,

    awaitingDecision:
      room.awaitingDecision,

    continuationMode:
      room.continuationMode,

    history:
      room.history,

    lastResult:
      room.lastResult,

    cheatingForfeit:
      room.cheatingForfeit,

    message:
      room.message,

    /* TIMER */
    turnDeadline:
      room.turnDeadline,

    /* DEALER */
    dealerSeat:
      room.dealerSeat
  };
}

function sendState(room) {
  io.to(room.code).emit(
    "state",
    publicState(room)
  );

  room.players.forEach(
    (player, seat) => {

      if (
        player &&
        !player.bot &&
        player.connected &&
        player.socketId
      ) {
        io
          .to(player.socketId)
          .emit(
            "hand",
            room.hands[seat]
          );

        io
          .to(player.socketId)
          .emit(
            "seat",
            seat
          );
      }
    }
  );
}

/* =========================
   TIMERS
========================= */

function clearBotTimer(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  room.turnDeadline = null;
}

function startTurnTimer(room) {
  clearTurnTimer(room);

  if (!room.started) {
    return;
  }

  const player =
    room.players[room.turn];

  if (!player) {
    return;
  }

  /* Boții au propriul timer */
  if (player.bot) {
    return;
  }

  room.turnDeadline =
    Date.now() + TURN_TIME;

  room.turnTimer =
    setTimeout(
      () => {

        room.turnTimer = null;
        room.turnDeadline = null;

        autoActionForHuman(room);

      },
      TURN_TIME
    );
}

/* =========================
   AUTO PLAY DUPĂ 20 SECUNDE
========================= */

function autoActionForHuman(room) {
  if (!room.started) {
    return;
  }

  const seat = room.turn;

  const player =
    room.players[seat];

  if (
    !player ||
    player.bot
  ) {
    return;
  }

  /*
    Dacă trebuie să aleagă
    CONTINUĂ / OPREȘTE,
    după 20 secunde continuăm
    automat dacă are carte.
  */

  if (
    room.awaitingDecision &&
    seat === room.opener
  ) {
    if (
      openerHasContinuation(room)
    ) {
      room.awaitingDecision = false;
      room.continuationMode = true;

      room.message =
        `⏱️ ${player.name} nu a ales în 20 secunde. Continuă automat.`;

      sendState(room);

      startTurnTimer(room);

      return;
    }

    finishPile(room);

    sendState(room);
    scheduleNextAction(room);

    return;
  }

  const hand =
    room.hands[seat];

  if (
    !hand ||
    hand.length === 0
  ) {
    return;
  }

  let validIndexes =
    hand.map(
      (_, index) => index
    );

  /*
    Dacă este continuarea,
    trebuie obligatoriu
    prima carte / 7 / 8.
  */

  if (room.continuationMode) {
    validIndexes =
      validIndexes.filter(
        index =>
          isCut(
            hand[index],
            room.openingRank
          )
      );
  }

  if (
    validIndexes.length === 0
  ) {
    finishPile(room);

    sendState(room);
    scheduleNextAction(room);

    return;
  }

  /*
    ALEGERE AUTOMATĂ RANDOM
  */

  const randomIndex =
    validIndexes[
      Math.floor(
        Math.random() *
        validIndexes.length
      )
    ];

  const card =
    hand[randomIndex];

  if (room.continuationMode) {
    room.cardsInCycle = 0;
    room.continuationMode = false;
  }

  hand.splice(
    randomIndex,
    1
  );

  if (
    room.table.length === 0
  ) {
    room.opener = seat;
    room.openingRank =
      card.rank;

    room.lastCutter =
      seat;
  }

  const cut =
    isCut(
      card,
      room.openingRank
    );

  if (cut) {
    room.lastCutter =
      seat;
  }

  room.table.push({
    player: seat,
    card,
    cut
  });

  room.cardsInCycle++;

  room.message =
    `⏱️ ${player.name} nu a jucat în 20 secunde. ` +
    `S-a ales automat ${card.rank}${card.suit}.`;

  afterCardPlayed(room);

  sendState(room);

  scheduleNextAction(room);
}

/* =========================
   CONTINUATION
========================= */

function openerHasContinuation(room) {
  if (
    room.opener === null ||
    room.openingRank === null
  ) {
    return false;
  }

  return room
    .hands[room.opener]
    .some(
      card =>
        isCut(
          card,
          room.openingRank
        )
    );
}

function gameIsFinished(room) {
  return room.hands.every(
    hand =>
      hand.length === 0
  );
}

/* =========================
   DEALER
========================= */

/*
  Echipa care pierde
  face cărțile în partida următoare.

  Se caută următorul jucător
  din echipa pierzătoare
  în sensul acelor de ceasornic.
*/

function nextDealerFromTeam(
  room,
  losingTeam
) {
  let start =
    room.dealerSeat === null ||
    room.dealerSeat === undefined
      ? 0
      : nextSeat(
          room.dealerSeat
        );

  for (
    let i = 0;
    i < 6;
    i++
  ) {
    const seat =
      (start + i) % 6;

    if (
      teamForSeat(seat) ===
      losingTeam
    ) {
      return seat;
    }
  }

  return losingTeam === 1
    ? 0
    : 1;
}

/* =========================
   FINISH GAME
========================= */

function finishGame(room) {
  clearBotTimer(room);
  clearTurnTimer(room);

  room.started = false;
  room.gameFinished = true;

  room.awaitingDecision =
    false;

  room.continuationMode =
    false;

  let winnerTeam = null;
  let loserTeam = null;

  if (
    room.cardPoints1 >
    room.cardPoints2
  ) {
    winnerTeam = 1;
    loserTeam = 2;

    room.matchScore1++;
  }

  else if (
    room.cardPoints2 >
    room.cardPoints1
  ) {
    winnerTeam = 2;
    loserTeam = 1;

    room.matchScore2++;
  }

  if (winnerTeam === null) {
    room.lastResult =
      `Egalitate ${room.cardPoints1}-${room.cardPoints2}`;

    room.message =
      `Partida s-a terminat ${room.cardPoints1}-${room.cardPoints2}. Egalitate.`;

    return;
  }

  /*
    PIERZĂTORII FAC URMĂTOARELE CĂRȚI
  */

  room.nextDealerSeat =
    nextDealerFromTeam(
      room,
      loserTeam
    );

  const loserPiles =
    loserTeam === 1
      ? room.piles1
      : room.piles2;

  const loserPoints =
    loserTeam === 1
      ? room.cardPoints1
      : room.cardPoints2;

  let special = "";

  if (loserPiles === 0) {
    special = "PIELE";
  }

  else if (
    loserPoints === 0
  ) {
    special = "BUZĂ";
  }

  room.lastResult =
    special
      ? `Echipa ${loserTeam}: ${special}`
      : `Echipa ${winnerTeam} câștigă`;

  const nextDealer =
    room.players[
      room.nextDealerSeat
    ];

  room.message =
    `Partida s-a terminat ${room.cardPoints1}-${room.cardPoints2}. ` +
    `Echipa ${winnerTeam} primește +1 la scor. ` +
    `${nextDealer?.name || "Jucătorul"} din Echipa ${loserTeam} va face următoarele cărți.` +
    (
      special
        ? ` Echipa ${loserTeam}: ${special}.`
        : ""
    );
}

/* =========================
   CHEATING
========================= */

function forfeitForCheating(
  room,
  cheatingTeam,
  reasons
) {
  if (
    !room.started ||
    room.gameFinished
  ) {
    return;
  }

  clearBotTimer(room);
  clearTurnTimer(room);

  const winnerTeam =
    otherTeam(
      cheatingTeam
    );

  room.started = false;
  room.gameFinished = true;

  room.awaitingDecision =
    false;

  room.continuationMode =
    false;

  room.cheatingForfeit =
    true;

  if (winnerTeam === 1) {
    room.matchScore1++;
  } else {
    room.matchScore2++;
  }

  /*
    Echipa care pierde prin
    trișare face cărțile.
  */

  room.nextDealerSeat =
    nextDealerFromTeam(
      room,
      cheatingTeam
    );

  room.lastResult =
    `🚩 Echipa ${cheatingTeam} pierde prin trișare`;

  room.message =
    `🚩 Partida s-a încheiat pentru trișare. ` +
    `Echipa ${cheatingTeam} pierde partida. ` +
    `Echipa ${winnerTeam} primește +1 la scor.`;

  room.history.push({
    type: "cheating",
    cheatingTeam,
    winnerTeam,

    reasons:
      [...new Set(reasons)]
  });
}

/* =========================
   FINISH PILE
========================= */

function finishPile(room) {
  clearTurnTimer(room);

  const points =
    countPoints(
      room.table
    );

  const winnerSeat =
    room.lastCutter;

  const winnerTeam =
    teamForSeat(
      winnerSeat
    );

  const winnerPlayer =
    room.players[
      winnerSeat
    ];

  if (winnerTeam === 1) {
    room.cardPoints1 +=
      points;

    room.piles1++;
  } else {
    room.cardPoints2 +=
      points;

    room.piles2++;
  }

  room.history.push({
    type: "round",

    round:
      room.roundNumber,

    openerSeat:
      room.opener,

    openerName:
      room.players[
        room.opener
      ]?.name ||
      "Jucător",

    openingRank:
      room.openingRank,

    cards:
      room.table.map(
        play => ({
          player:
            play.player,

          name:
            room.players[
              play.player
            ]?.name ||
            "Jucător",

          rank:
            play.card.rank,

          suit:
            play.card.suit,

          cut:
            play.cut
        })
      ),

    winnerSeat,

    winnerName:
      winnerPlayer?.name ||
      "Jucător",

    winnerTeam,

    points
  });

  room.message =
    `${winnerPlayer?.name || "Jucătorul"} a luat cărțile pentru Echipa ${winnerTeam}. ` +
    (
      points === 0
        ? "0 puncte."
        : `${points} punct${points === 1 ? "" : "e"}.`
    );

  room.table = [];

  room.openingRank = null;

  room.cardsInCycle = 0;

  room.awaitingDecision =
    false;

  room.continuationMode =
    false;

  if (
    gameIsFinished(room)
  ) {
    finishGame(room);
    return;
  }

  room.roundNumber++;

  room.opener =
    winnerSeat;

  room.turn =
    winnerSeat;

  room.lastCutter =
    winnerSeat;
}

/* =========================
   AFTER CARD
========================= */

function afterCardPlayed(room) {
  if (
    room.cardsInCycle < 6
  ) {
    room.turn =
      nextSeat(
        room.turn
      );

    return;
  }

  if (
    openerHasContinuation(room)
  ) {
    room.awaitingDecision =
      true;

    room.continuationMode =
      false;

    room.turn =
      room.opener;

    room.message =
      `${room.players[room.opener].name} poate continua sau opri runda.`;

    return;
  }

  finishPile(room);
}

/* =========================
   START GAME
========================= */

function startCurrentGame(room) {
  clearBotTimer(room);
  clearTurnTimer(room);

  const deck =
    makeDeck();

  room.hands =
    Array.from(
      { length: 6 },
      () => []
    );

  /*
    Dacă partida anterioară
    a avut un pierzător,
    acel dealer este folosit.
  */

  if (
    room.nextDealerSeat !== null &&
    room.nextDealerSeat !== undefined
  ) {
    room.dealerSeat =
      room.nextDealerSeat;
  }

  /*
    Prima carte se dă
    jucătorului următor
    după dealer, clockwise.
  */

  const firstSeat =
    nextSeat(
      room.dealerSeat
    );

  /*
    Împărțire clockwise:
    câte o carte fiecăruia,
    5 ture.
  */

  for (
    let round = 0;
    round < 5;
    round++
  ) {
    for (
      let offset = 0;
      offset < 6;
      offset++
    ) {
      const seat =
        (
          firstSeat +
          offset
        ) % 6;

      room.hands[
        seat
      ].push(
        deck.pop()
      );
    }
  }

  room.nextDealerSeat =
    null;

  room.gameId++;

  room.cardPoints1 = 0;
  room.cardPoints2 = 0;

  room.piles1 = 0;
  room.piles2 = 0;

  room.table = [];
  room.history = [];

  room.roundNumber = 1;

  room.cardsInCycle = 0;

  room.awaitingDecision =
    false;

  room.continuationMode =
    false;

  room.openingRank =
    null;

  /*
    Începe jucătorul
    de după dealer.
  */

  room.opener =
    firstSeat;

  room.turn =
    firstSeat;

  room.lastCutter =
    firstSeat;

  room.gameFinished =
    false;

  room.cheatingForfeit =
    false;

  room.cheatReports = {
    1: new Map(),
    2: new Map()
  };

  room.lastResult = "";

  room.started = true;

  room.message =
    `${room.players[room.dealerSeat]?.name || "Jucătorul"} face cărțile. ` +
    `${room.players[firstSeat]?.name || "Jucătorul"} începe.`;
}

/* =========================
   BOTS
========================= */

function scheduleBot(
  room,
  delay = BOT_DELAY
) {
  clearBotTimer(room);

  if (!room.started) {
    return;
  }

  const player =
    room.players[
      room.turn
    ];

  if (
    !player ||
    !player.bot
  ) {
    return;
  }

  room.botTimer =
    setTimeout(
      () => {
        room.botTimer = null;
        runBot(room);
      },
      delay
    );
}

function scheduleNextAction(room) {
  if (!room.started) {
    return;
  }

  const player =
    room.players[
      room.turn
    ];

  if (!player) {
    return;
  }

  if (player.bot) {
    scheduleBot(
      room,
      room.awaitingDecision
        ? BOT_DECISION_DELAY
        : BOT_DELAY
    );
  } else {
    startTurnTimer(room);

    /*
      Trimitem deadline-ul
      imediat la client.
    */

    sendState(room);
  }
}

function runBot(room) {
  if (!room.started) {
    return;
  }

  const seat =
    room.turn;

  const bot =
    room.players[
      seat
    ];

  if (
    !bot ||
    !bot.bot
  ) {
    return;
  }

  /*
    BOT DECIZIE CONTINUARE
  */

  if (
    room.awaitingDecision &&
    seat === room.opener
  ) {
    if (
      openerHasContinuation(room)
    ) {
      room.awaitingDecision =
        false;

      room.continuationMode =
        true;

      room.message =
        `${bot.name} continuă runda.`;

      sendState(room);

      scheduleBot(
        room,
        BOT_DECISION_DELAY
      );

      return;
    }

    finishPile(room);

    sendState(room);
    scheduleNextAction(room);

    return;
  }

  const hand =
    room.hands[seat];

  if (
    !hand ||
    hand.length === 0
  ) {
    return;
  }

  let index = 0;

  if (
    room.continuationMode
  ) {
    index =
      hand.findIndex(
        card =>
          isCut(
            card,
            room.openingRank
          )
      );

    if (index === -1) {
      finishPile(room);

      sendState(room);
      scheduleNextAction(room);

      return;
    }

    room.cardsInCycle = 0;

    room.continuationMode =
      false;
  }

  else if (
    room.table.length > 0
  ) {
    const cutIndex =
      hand.findIndex(
        card =>
          isCut(
            card,
            room.openingRank
          )
      );

    if (
      cutIndex !== -1
    ) {
      index =
        cutIndex;
    }
  }

  const card =
    hand[index];

  hand.splice(
    index,
    1
  );

  if (
    room.table.length === 0
  ) {
    room.opener =
      seat;

    room.openingRank =
      card.rank;

    room.lastCutter =
      seat;
  }

  const cut =
    isCut(
      card,
      room.openingRank
    );

  if (cut) {
    room.lastCutter =
      seat;

    room.message =
      `${bot.name} a tăiat. Echipa ${teamForSeat(seat)} are momentan mâna.`;
  } else {
    room.message =
      `${bot.name} a jucat ${card.rank}${card.suit}.`;
  }

  room.table.push({
    player: seat,
    card,
    cut
  });

  room.cardsInCycle++;

  afterCardPlayed(room);

  sendState(room);

  scheduleNextAction(room);
}

/* =========================
   SOCKET
========================= */

io.on(
  "connection",
  socket => {

    /* CREATE ROOM */

    socket.on(
      "createRoom",
      (
        { name, team },
        callback
      ) => {

        team =
          Number(team);

        if (
          team !== 1 &&
          team !== 2
        ) {
          return callback({
            ok: false,
            error:
              "Alege Echipa 1 sau Echipa 2."
          });
        }

        const code =
          createRoomCode();

        const players =
          Array(6).fill(null);

        const hostSeat =
          team === 1
            ? 0
            : 1;

        players[
          hostSeat
        ] = {
          socketId:
            socket.id,

          name:
            String(
              name || ""
            ).trim() ||
            "Jucător",

          connected:
            true,

          bot:
            false,

          voiceEnabled:
            false,

          speaking:
            false
        };

        const room = {
          code,

          hostId:
            socket.id,

          players,

          hands:
            Array.from(
              { length: 6 },
              () => []
            ),

          started:
            false,

          gameFinished:
            false,

          gameId:
            0,

          matchScore1:
            0,

          matchScore2:
            0,

          cardPoints1:
            0,

          cardPoints2:
            0,

          piles1:
            0,

          piles2:
            0,

          roundNumber:
            1,

          turn:
            hostSeat,

          opener:
            hostSeat,

          openingRank:
            null,

          table:
            [],

          lastCutter:
            null,

          cardsInCycle:
            0,

          awaitingDecision:
            false,

          continuationMode:
            false,

          history:
            [],

          lastResult:
            "",

          cheatingForfeit:
            false,

          cheatReports: {
            1: new Map(),
            2: new Map()
          },

          botTimer:
            null,

          turnTimer:
            null,

          turnDeadline:
            null,

          /*
            Inițial J6 face cărțile.
            După aceea pierzătorii.
          */

          dealerSeat:
            5,

          nextDealerSeat:
            null,

          message:
            "Camera a fost creată."
        };

        rooms.set(
          code,
          room
        );

        socket.join(
          code
        );

        callback({
          ok: true,
          code,
          seat:
            hostSeat
        });

        sendState(room);
      }
    );

    /* JOIN */

    socket.on(
      "joinRoom",
      (
        {
          code,
          name,
          team
        },
        callback
      ) => {

        code =
          String(
            code || ""
          ).trim();

        team =
          Number(team);

        if (
          team !== 1 &&
          team !== 2
        ) {
          return callback({
            ok: false,
            error:
              "Alege Echipa 1 sau Echipa 2."
          });
        }

        const room =
          rooms.get(code);

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (room.started) {
          return callback({
            ok: false,
            error:
              "Partida a început deja."
          });
        }

        const seat =
          firstFreeSeatForTeam(
            room,
            team
          );

        if (seat === -1) {
          return callback({
            ok: false,
            error:
              `Echipa ${team} este plină.`
          });
        }

        room.players[
          seat
        ] = {
          socketId:
            socket.id,

          name:
            String(
              name || ""
            ).trim() ||
            `Jucător ${seat + 1}`,

          connected:
            true,

          bot:
            false,

          voiceEnabled:
            false,

          speaking:
            false
        };

        socket.join(
          code
        );

        callback({
          ok: true,
          code,
          seat
        });

        room.message =
          `${playerCount(room)}/6 jucători la masă.`;

        sendState(room);
      }
    );

    /* CHANGE TEAM */

    socket.on(
      "changeTeam",
      (
        { code, team },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (room.started) {
          return callback({
            ok: false,
            error:
              "Nu poți schimba echipa după start."
          });
        }

        team =
          Number(team);

        if (
          team !== 1 &&
          team !== 2
        ) {
          return callback({
            ok: false,
            error:
              "Echipă invalidă."
          });
        }

        const oldSeat =
          room.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (
          oldSeat === -1
        ) {
          return callback({
            ok: false,
            error:
              "Nu ești în cameră."
          });
        }

        if (
          teamForSeat(
            oldSeat
          ) === team
        ) {
          return callback({
            ok: true
          });
        }

        const newSeat =
          firstFreeSeatForTeam(
            room,
            team
          );

        if (
          newSeat === -1
        ) {
          return callback({
            ok: false,
            error:
              `Echipa ${team} este plină.`
          });
        }

        const player =
          room.players[
            oldSeat
          ];

        room.players[
          oldSeat
        ] = null;

        room.players[
          newSeat
        ] = player;

        room.hands[
          oldSeat
        ] = [];

        room.hands[
          newSeat
        ] = [];

        callback({
          ok: true
        });

        sendState(room);
      }
    );

    /* FILL BOTS */

    socket.on(
      "fillWithBots",
      (
        { code },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (
          socket.id !==
          room.hostId
        ) {
          return callback({
            ok: false,
            error:
              "Doar host-ul poate porni testul."
          });
        }

        if (room.started) {
          return callback({
            ok: false,
            error:
              "Partida este deja pornită."
          });
        }

        for (
          let seat = 0;
          seat < 6;
          seat++
        ) {
          if (
            !room.players[
              seat
            ]
          ) {
            room.players[
              seat
            ] = {
              socketId:
                null,

              name:
                `Bot ${seat + 1}`,

              connected:
                true,

              bot:
                true,

              voiceEnabled:
                false,

              speaking:
                false
            };
          }
        }

        startCurrentGame(
          room
        );

        callback({
          ok: true
        });

        sendState(room);

        scheduleNextAction(
          room
        );
      }
    );

    /* START */

    socket.on(
      "startGame",
      (
        { code },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (
          socket.id !==
          room.hostId
        ) {
          return callback({
            ok: false,
            error:
              "Doar host-ul poate porni."
          });
        }

        if (
          playerCount(room) !==
            6 ||
          !teamsAreValid(room)
        ) {
          return callback({
            ok: false,
            error:
              "Trebuie să fie 3 vs 3."
          });
        }

        startCurrentGame(
          room
        );

        callback({
          ok: true
        });

        sendState(room);

        scheduleNextAction(
          room
        );
      }
    );

    /* CONTINUE */

    socket.on(
      "continueRound",
      (
        { code },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        const seat =
          room?.players.findIndex(
            p =>
              p &&
              p.socketId ===
                socket.id
          );

        if (
          !room ||
          seat !==
            room.opener ||
          !room.awaitingDecision
        ) {
          return callback({
            ok: false,
            error:
              "Nu poți continua acum."
          });
        }

        if (
          !openerHasContinuation(
            room
          )
        ) {
          return callback({
            ok: false,
            error:
              "Nu ai cu ce continua."
          });
        }

        clearTurnTimer(
          room
        );

        room.awaitingDecision =
          false;

        room.continuationMode =
          true;

        callback({
          ok: true
        });

        sendState(room);

        scheduleNextAction(
          room
        );
      }
    );

    /* STOP */

    socket.on(
      "stopRound",
      (
        { code },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        const seat =
          room?.players.findIndex(
            p =>
              p &&
              p.socketId ===
                socket.id
          );

        if (
          !room ||
          seat !==
            room.opener ||
          !room.awaitingDecision
        ) {
          return callback({
            ok: false,
            error:
              "Nu poți opri acum."
          });
        }

        clearTurnTimer(
          room
        );

        finishPile(
          room
        );

        callback({
          ok: true
        });

        sendState(room);

        scheduleNextAction(
          room
        );
      }
    );

    /* PLAY CARD */

    socket.on(
      "playCard",
      (
        {
          code,
          index
        },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        const seat =
          room.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (
          seat === -1 ||
          !room.started ||
          seat !==
            room.turn
        ) {
          return callback({
            ok: false,
            error:
              "Nu este rândul tău."
          });
        }

        if (
          room.awaitingDecision
        ) {
          return callback({
            ok: false,
            error:
              "Alege Continuă sau Oprește."
          });
        }

        index =
          Number(index);

        const playerHand =
          room.hands[
            seat
          ];

        if (
          !Number.isInteger(
            index
          ) ||
          index < 0 ||
          index >=
            playerHand.length
        ) {
          return callback({
            ok: false,
            error:
              "Carte invalidă."
          });
        }

        const card =
          playerHand[index];

        if (
          room.continuationMode
        ) {
          if (
            !isCut(
              card,
              room.openingRank
            )
          ) {
            return callback({
              ok: false,
              error:
                `Trebuie ${room.openingRank}, 7 sau 8.`
            });
          }
        }

        /*
          OPRIM TIMERUL
          pentru că a jucat.
        */

        clearTurnTimer(
          room
        );

        if (
          room.continuationMode
        ) {
          room.cardsInCycle =
            0;

          room.continuationMode =
            false;
        }

        playerHand.splice(
          index,
          1
        );

        if (
          room.table.length ===
          0
        ) {
          room.opener =
            seat;

          room.openingRank =
            card.rank;

          room.lastCutter =
            seat;
        }

        const cut =
          isCut(
            card,
            room.openingRank
          );

        if (cut) {
          room.lastCutter =
            seat;

          room.message =
            `${room.players[seat].name} a tăiat. Echipa ${teamForSeat(seat)} are momentan mâna.`;
        } else {
          room.message =
            `${room.players[seat].name} a jucat ${card.rank}${card.suit}.`;
        }

        room.table.push({
          player:
            seat,

          card,

          cut
        });

        room.cardsInCycle++;

        afterCardPlayed(
          room
        );

        callback({
          ok: true
        });

        sendState(room);

        scheduleNextAction(
          room
        );
      }
    );

    /* =========================
       CHAT
    ========================= */

    socket.on(
      "chatMessage",
      (
        { code, text },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        const seat =
          room?.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (
          !room ||
          seat === -1
        ) {
          return callback?.({
            ok: false,
            error:
              "Nu ești în cameră."
          });
        }

        text =
          String(
            text || ""
          )
            .trim()
            .slice(
              0,
              200
            );

        if (!text) {
          return callback?.({
            ok: false
          });
        }

        io
          .to(room.code)
          .emit(
            "chatMessage",
            {
              name:
                room.players[
                  seat
                ].name,

              text
            }
          );

        callback?.({
          ok: true
        });
      }
    );

    /* =========================
       EMOJI
    ========================= */

    socket.on(
      "sendEmoji",
      (
        {
          code,
          emoji
        },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        const seat =
          room?.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (
          !room ||
          seat === -1 ||
          !ALLOWED_EMOJIS.includes(
            emoji
          )
        ) {
          return callback?.({
            ok: false
          });
        }

        io
          .to(room.code)
          .emit(
            "playerEmoji",
            {
              seat,
              emoji
            }
          );

        callback?.({
          ok: true
        });
      }
    );

    /* =========================
       REPORT
    ========================= */

    socket.on(
      "reportCheating",
      (
        {
          code,
          reason
        },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (!room.started) {
          return callback({
            ok: false,
            error:
              "Poți raporta doar în timpul unei partide."
          });
        }

        if (
          !REPORT_REASONS.includes(
            reason
          )
        ) {
          return callback({
            ok: false,
            error:
              "Motiv invalid."
          });
        }

        const seat =
          room.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (seat === -1) {
          return callback({
            ok: false,
            error:
              "Nu ești jucător în această cameră."
          });
        }

        const reporterTeam =
          teamForSeat(
            seat
          );

        const reportedTeam =
          otherTeam(
            reporterTeam
          );

        if (
          room
            .cheatReports[
              reportedTeam
            ]
            .has(seat)
        ) {
          return callback({
            ok: false,
            error:
              "Ai raportat deja în această partidă."
          });
        }

        room
          .cheatReports[
            reportedTeam
          ]
          .set(
            seat,
            reason
          );

        const reports =
          room
            .cheatReports[
              reportedTeam
            ];

        /*
          DOUĂ RAPOARTE
          = FORFEIT
        */

        if (
          reports.size >= 2
        ) {
          const reasons =
            [...reports.values()];

          forfeitForCheating(
            room,
            reportedTeam,
            reasons
          );

          const winnerTeam =
            otherTeam(
              reportedTeam
            );

          io
            .to(room.code)
            .emit(
              "cheatingConfirmed",
              {
                cheatingTeam:
                  reportedTeam,

                winnerTeam
              }
            );

          callback({
            ok: true,
            forfeit: true
          });

          sendState(room);

          return;
        }

        callback({
          ok: true,
          forfeit: false
        });

        room.message =
          `🚩 A fost trimis un raport împotriva Echipei ${reportedTeam}.`;

        sendState(room);
      }
    );

    /* =========================
       VOICE

       IMPORTANT:
       voiceReady = ascultător.

       NU trebuie microfon pornit
       ca să auzi.
    ========================= */

    socket.on(
      "voiceReady",
      (
        { code },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback?.({
            ok: false
          });
        }

        const seat =
          room.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (seat === -1) {
          return callback?.({
            ok: false
          });
        }

        const player =
          room.players[
            seat
          ];

        player.voiceEnabled =
          true;

        /*
          Toți cei conectați la
          voice chat, indiferent dacă
          au microfonul pornit.
        */

        const peers =
          room.players
            .filter(
              p =>
                p &&
                !p.bot &&
                p.connected &&
                p.voiceEnabled &&
                p.socketId &&
                p.socketId !==
                  socket.id
            )
            .map(
              p => ({
                socketId:
                  p.socketId
              })
            );

        callback?.({
          ok: true,
          peers
        });

        socket
          .to(room.code)
          .emit(
            "voicePeerAvailable",
            {
              socketId:
                socket.id
            }
          );

        sendState(room);
      }
    );

    socket.on(
      "voiceStopped",
      ({ code }) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return;
        }

        const seat =
          room.players.findIndex(
            p =>
              p &&
              p.socketId ===
                socket.id
          );

        if (seat === -1) {
          return;
        }

        room.players[
          seat
        ].voiceEnabled =
          false;

        room.players[
          seat
        ].speaking =
          false;

        socket
          .to(room.code)
          .emit(
            "voicePeerStopped",
            {
              socketId:
                socket.id
            }
          );

        io
          .to(room.code)
          .emit(
            "voiceSpeaking",
            {
              seat,
              speaking:
                false
            }
          );

        sendState(room);
      }
    );

    /* WEBRTC SIGNAL */

    socket.on(
      "webrtcSignal",
      ({
        code,
        target,
        data
      }) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return;
        }

        const sender =
          room.players.find(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        const receiver =
          room.players.find(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                target
          );

        if (
          !sender ||
          !receiver
        ) {
          return;
        }

        io
          .to(target)
          .emit(
            "webrtcSignal",
            {
              from:
                socket.id,

              data
            }
          );
      }
    );

    /* SPEAKING */

    socket.on(
      "voiceSpeaking",
      ({
        code,
        speaking
      }) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return;
        }

        const seat =
          room.players.findIndex(
            p =>
              p &&
              !p.bot &&
              p.socketId ===
                socket.id
          );

        if (seat === -1) {
          return;
        }

        room.players[
          seat
        ].speaking =
          !!speaking;

        io
          .to(room.code)
          .emit(
            "voiceSpeaking",
            {
              seat,
              speaking:
                !!speaking
            }
          );
      }
    );

    /* =========================
       KICK
    ========================= */

    socket.on(
      "kickPlayer",
      (
        {
          code,
          seat
        },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        if (
          room.hostId !==
          socket.id
        ) {
          return callback({
            ok: false,
            error:
              "Doar host-ul poate da afară."
          });
        }

        if (room.started) {
          return callback({
            ok: false,
            error:
              "Nu poți da afară după start."
          });
        }

        seat =
          Number(seat);

        const player =
          room.players[
            seat
          ];

        if (
          !player ||
          player.bot
        ) {
          return callback({
            ok: false,
            error:
              "Jucător invalid."
          });
        }

        if (
          player.socketId ===
          socket.id
        ) {
          return callback({
            ok: false,
            error:
              "Nu te poți da singur afară."
          });
        }

        io
          .to(player.socketId)
          .emit("kicked");

        const targetSocket =
          io.sockets.sockets.get(
            player.socketId
          );

        if (targetSocket) {
          targetSocket.leave(
            room.code
          );
        }

        room.players[
          seat
        ] = null;

        room.hands[
          seat
        ] = [];

        room.message =
          `${player.name} a fost scos din cameră.`;

        callback({
          ok: true
        });

        sendState(room);
      }
    );

    /* =========================
       DISCONNECT
    ========================= */

    socket.on(
      "disconnect",
      () => {

        for (
          const [
            code,
            room
          ] of rooms
        ) {

          const seat =
            room.players.findIndex(
              p =>
                p &&
                !p.bot &&
                p.socketId ===
                  socket.id
            );

          if (
            seat === -1
          ) {
            continue;
          }

          const player =
            room.players[
              seat
            ];

          player.voiceEnabled =
            false;

          player.speaking =
            false;

          socket
            .to(room.code)
            .emit(
              "voicePeerStopped",
              {
                socketId:
                  socket.id
              }
            );

          if (!room.started) {

            room.players[
              seat
            ] = null;

            room.hands[
              seat
            ] = [];

            /*
              Dacă host-ul pleacă,
              dăm host următorului om.
            */

            if (
              room.hostId ===
              socket.id
            ) {
              const nextHost =
                firstHumanPlayer(
                  room
                );

              if (nextHost) {
                room.hostId =
                  nextHost.socketId;
              } else {
                rooms.delete(
                  code
                );

                continue;
              }
            }

            room.message =
              `${player.name} a ieșit din cameră.`;
          }

          else {

            player.connected =
              false;

            room.message =
              `${player.name} s-a deconectat.`;

            /*
              Dacă era rândul lui,
              timerul de 20 secunde
              va juca automat cartea.
            */
          }

          sendState(room);

          break;
        }
      }
    );
  }
);

/* =========================
   SERVER
========================= */

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Șeptică server pornit pe portul ${PORT}`
    );
  }
);
