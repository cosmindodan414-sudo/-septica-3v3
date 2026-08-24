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

/* =====================================================
   ECHIPE
===================================================== */

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
  return seatsForTeam(team)
    .filter(seat => room.players[seat])
    .length;
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
    player =>
      player &&
      !player.bot &&
      player.connected
  );
}

/* =====================================================
   CĂRȚI
===================================================== */

function shuffle(array) {
  for (
    let i = array.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
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

function makeDeck() {
  const deck = [];

  // 4 șeptari
  for (const suit of suits) {
    deck.push({
      rank: "7",
      suit
    });
  }

  // doar 2 optari
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

  // 9,10,J,Q,K,A x4
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
      sum +
      (
        isPoint(play.card)
          ? 1
          : 0
      ),
    0
  );
}

/* =====================================================
   CAMERE
===================================================== */

function createRoomCode() {
  let code;

  do {
    code =
      String(
        Math.floor(
          100000 +
          Math.random() * 900000
        )
      );
  } while (
    rooms.has(code)
  );

  return code;
}

/* =====================================================
   STATE
===================================================== */

function publicState(room) {
  return {
    hostId:
      room.hostId,

    started:
      room.started,

    gameFinished:
      room.gameFinished,

    gameId:
      room.gameId,

    players:
      room.players.map(
        (player, seat) => {

          if (!player) {
            return null;
          }

          return {
            name:
              player.name,

            team:
              teamForSeat(seat),

            bot:
              !!player.bot,

            connected:
              player.connected,

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
      room.message
  };
}

function sendState(room) {
  io
    .to(room.code)
    .emit(
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

/* =====================================================
   GAME HELPERS
===================================================== */

function nextSeat(seat) {
  return (seat + 1) % 6;
}

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
    hand => hand.length === 0
  );
}

function clearBotTimer(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

/* =====================================================
   FINAL PARTIDĂ NORMALĂ
===================================================== */

function finishGame(room) {
  clearBotTimer(room);

  room.started = false;
  room.gameFinished = true;
  room.awaitingDecision = false;
  room.continuationMode = false;

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

  else if (loserPoints === 0) {
    special = "BUZĂ";
  }

  room.lastResult =
    special
      ? `Echipa ${loserTeam}: ${special}`
      : `Echipa ${winnerTeam} câștigă`;

  room.message =
    `Partida s-a terminat ${room.cardPoints1}-${room.cardPoints2}. ` +
    `Echipa ${winnerTeam} primește +1 la scor.` +
    (
      special
        ? ` Echipa ${loserTeam}: ${special}.`
        : ""
    );
}

/* =====================================================
   PIERDERE PRIN TRIȘARE
===================================================== */

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

  const winnerTeam =
    otherTeam(cheatingTeam);

  room.started = false;
  room.gameFinished = true;

  room.awaitingDecision = false;
  room.continuationMode = false;

  room.cheatingForfeit = true;

  if (winnerTeam === 1) {
    room.matchScore1++;
  } else {
    room.matchScore2++;
  }

  room.lastResult =
    `🚩 Echipa ${cheatingTeam} pierde prin trișare`;

  room.message =
    `🚩 Partida s-a încheiat pentru trișare. ` +
    `Echipa ${cheatingTeam} pierde partida. ` +
    `Echipa ${winnerTeam} primește +1 la scor.`;

  room.history.push({
    type:
      "cheating",

    cheatingTeam,

    winnerTeam,

    reasons:
      [...new Set(reasons)]
  });
}

/* =====================================================
   TERMINĂ GRĂMADA
===================================================== */

function finishPile(room) {
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
    room.cardPoints1 += points;
    room.piles1++;
  } else {
    room.cardPoints2 += points;
    room.piles2++;
  }

  room.history.push({
    type:
      "round",

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
  room.awaitingDecision = false;
  room.continuationMode = false;

  if (gameIsFinished(room)) {
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

/* =====================================================
   DUPĂ O CARTE
===================================================== */

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

/* =====================================================
   START PARTIDĂ
===================================================== */

function startCurrentGame(room) {
  clearBotTimer(room);

  const deck =
    makeDeck();

  room.hands =
    Array.from(
      { length: 6 },
      () => []
    );

  for (
    let round = 0;
    round < 5;
    round++
  ) {
    for (
      let seat = 0;
      seat < 6;
      seat++
    ) {
      room.hands[
        seat
      ].push(
        deck.pop()
      );
    }
  }

  room.gameId++;

  room.cardPoints1 = 0;
  room.cardPoints2 = 0;

  room.piles1 = 0;
  room.piles2 = 0;

  room.table = [];
  room.history = [];

  room.roundNumber = 1;

  room.cardsInCycle = 0;

  room.awaitingDecision = false;
  room.continuationMode = false;

  room.openingRank = null;

  room.opener = 0;
  room.turn = 0;

  room.lastCutter = null;

  room.gameFinished = false;

  room.cheatingForfeit = false;

  room.cheatReports = {
    1: new Map(),
    2: new Map()
  };

  room.lastResult = "";

  room.started = true;

  room.message =
    `${room.players[0].name} începe prima rundă.`;
}

/* =====================================================
   BOȚI
===================================================== */

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

  if (
    room.awaitingDecision &&
    seat === room.opener
  ) {
    if (
      openerHasContinuation(
        room
      )
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
    scheduleBot(room);

    return;
  }

  const hand =
    room.hands[
      seat
    ];

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
      scheduleBot(room);
      return;
    }

    room.cardsInCycle = 0;
    room.continuationMode = false;
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
    room.opener = seat;
    room.openingRank = card.rank;
    room.lastCutter = seat;
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
    player:
      seat,

    card,

    cut
  });

  room.cardsInCycle++;

  afterCardPlayed(room);

  sendState(room);
  scheduleBot(room);
}

/* =====================================================
   SOCKET.IO
===================================================== */

io.on(
  "connection",
  socket => {

    /* =========================
       CREATE
    ========================= */

    socket.on(
      "createRoom",
      (
        {
          name,
          team
        },
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
          seat: hostSeat
        });

        sendState(room);
      }
    );

    /* =========================
       JOIN
    ========================= */

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

        if (
          seat === -1
        ) {
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

        socket.join(code);

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

    /* =========================
       SCHIMBĂ ECHIPA
    ========================= */

    socket.on(
      "changeTeam",
      (
        {
          code,
          team
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

        if (room.started) {
          return callback({
            ok: false,
            error:
              "Nu poți schimba echipa după start."
          });
        }

        team =
          Number(team);

        const oldSeat =
          room.players.findIndex(
            player =>
              player &&
              !player.bot &&
              player.socketId ===
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
          teamForSeat(oldSeat) ===
          team
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

    /* =========================
       BOȚI
    ========================= */

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
          const seat of [
            ...TEAM_1_SEATS,
            ...TEAM_2_SEATS
          ]
        ) {
          if (
            !room.players[seat]
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

        startCurrentGame(room);

        callback({
          ok: true
        });

        sendState(room);
        scheduleBot(room);
      }
    );

    /* =========================
       START
    ========================= */

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
          playerCount(room) !== 6 ||
          !teamsAreValid(room)
        ) {
          return callback({
            ok: false,
            error:
              "Trebuie să fie 3 vs 3."
          });
        }

        startCurrentGame(room);

        callback({
          ok: true
        });

        sendState(room);
        scheduleBot(room);
      }
    );

    /* =========================
       CONTINUE
    ========================= */

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
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          !room ||
          seat !== room.opener ||
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

        room.awaitingDecision =
          false;

        room.continuationMode =
          true;

        callback({
          ok: true
        });

        sendState(room);
      }
    );

    /* =========================
       STOP
    ========================= */

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
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          !room ||
          seat !== room.opener ||
          !room.awaitingDecision
        ) {
          return callback({
            ok: false,
            error:
              "Nu poți opri acum."
          });
        }

        finishPile(room);

        callback({
          ok: true
        });

        sendState(room);
        scheduleBot(room);
      }
    );

    /* =========================
       PLAY
    ========================= */

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
            player =>
              player &&
              !player.bot &&
              player.socketId ===
                socket.id
          );

        if (
          seat === -1 ||
          !room.started ||
          seat !== room.turn
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

        const hand =
          room.hands[seat];

        index =
          Number(index);

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= hand.length
        ) {
          return callback({
            ok: false,
            error:
              "Carte invalidă."
          });
        }

        const card =
          hand[index];

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

          room.cardsInCycle = 0;
          room.continuationMode = false;
        }

        hand.splice(
          index,
          1
        );

        if (
          room.table.length === 0
        ) {
          room.opener = seat;
          room.openingRank = card.rank;
          room.lastCutter = seat;
        }

        const cut =
          isCut(
            card,
            room.openingRank
          );

        if (cut) {
          room.lastCutter = seat;

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

        afterCardPlayed(room);

        callback({
          ok: true
        });

        sendState(room);
        scheduleBot(room);
      }
    );

    /* =========================
       CHAT
    ========================= */

    socket.on(
      "chatMessage",
      (
        {
          code,
          text
        },
        callback
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        const seat =
          room?.players.findIndex(
            player =>
              player &&
              !player.bot &&
              player.socketId ===
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
            player =>
              player &&
              !player.bot &&
              player.socketId ===
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
       RAPORT TRIȘARE
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
            player =>
              player &&
              !player.bot &&
              player.socketId ===
                socket.id
          );

        if (
          seat === -1
        ) {
          return callback({
            ok: false,
            error:
              "Nu ești jucător în această cameră."
          });
        }

        const reporterTeam =
          teamForSeat(seat);

        const reportedTeam =
          otherTeam(
            reporterTeam
          );

        /*
        Același jucător
        poate raporta o singură dată.
        */

        if (
          room.cheatReports[
            reportedTeam
          ].has(seat)
        ) {
          return callback({
            ok: false,
            error:
              "Ai raportat deja în această partidă."
          });
        }

        room.cheatReports[
          reportedTeam
        ].set(
          seat,
          reason
        );

        const reports =
          room.cheatReports[
            reportedTeam
          ];

        /*
        La două rapoarte diferite
        echipa raportată pierde.
        */

        if (
          reports.size >= 2
        ) {
          forfeitForCheating(
            room,
            reportedTeam,
            [...reports.values()]
          );

          sendState(room);

          io
            .to(room.code)
            .emit(
              "cheatingConfirmed",
              {
                cheatingTeam:
                  reportedTeam,

                winnerTeam:
                  reporterTeam
              }
            );

          return callback({
            ok: true,
            forfeit: true
          });
        }

        callback({
          ok: true,
          forfeit: false,
          message:
            "Raportul a fost trimis."
        });
      }
    );

    /* =========================
       VOICE READY
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
          return callback({
            ok: false,
            error:
              "Camera nu există."
          });
        }

        const seat =
          room.players.findIndex(
            player =>
              player &&
              !player.bot &&
              player.socketId ===
                socket.id
          );

        if (
          seat === -1
        ) {
          return callback({
            ok: false,
            error:
              "Nu ești în cameră."
          });
        }

        const player =
          room.players[
            seat
          ];

        player.voiceEnabled =
          true;

        player.speaking =
          false;

        const peers =
          room.players
            .map(
              (
                other,
                otherSeat
              ) => {

                if (
                  !other ||
                  other.bot ||
                  !other.voiceEnabled ||
                  !other.socketId ||
                  other.socketId ===
                    socket.id
                ) {
                  return null;
                }

                return {
                  socketId:
                    other.socketId,

                  seat:
                    otherSeat,

                  name:
                    other.name
                };
              }
            )
            .filter(Boolean);

        socket
          .to(room.code)
          .emit(
            "voicePeerAvailable",
            {
              socketId:
                socket.id,

              seat,

              name:
                player.name
            }
          );

        callback({
          ok: true,
          peers
        });

        sendState(room);
      }
    );

    /* =========================
       VOICE STOP
    ========================= */

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
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          seat === -1
        ) {
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
                socket.id,

              seat
            }
          );

        sendState(room);
      }
    );

    /* =========================
       WEBRTC SIGNAL
    ========================= */

    socket.on(
      "webrtcSignal",
      (
        {
          code,
          target,
          data
        }
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return;
        }

        const senderSeat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        const targetSeat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId ===
                target
          );

        if (
          senderSeat === -1 ||
          targetSeat === -1
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

              seat:
                senderSeat,

              data
            }
          );
      }
    );

    /* =========================
       SPEAKING
    ========================= */

    socket.on(
      "voiceSpeaking",
      (
        {
          code,
          speaking
        }
      ) => {

        const room =
          rooms.get(
            String(code)
          );

        if (!room) {
          return;
        }

        const seat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          seat === -1
        ) {
          return;
        }

        const player =
          room.players[
            seat
          ];

        if (
          !player.voiceEnabled
        ) {
          return;
        }

        player.speaking =
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

        if (
          !room ||
          socket.id !==
            room.hostId
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

        if (!player) {
          return callback({
            ok: false,
            error:
              "Loc liber."
          });
        }

        if (
          player.socketId ===
          room.hostId
        ) {
          return callback({
            ok: false,
            error:
              "Host-ul nu se poate scoate."
          });
        }

        if (
          !player.bot &&
          player.socketId
        ) {
          io
            .to(
              player.socketId
            )
            .emit(
              "kicked"
            );
        }

        room.players[
          seat
        ] = null;

        room.hands[
          seat
        ] = [];

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
          const room
          of rooms.values()
        ) {
          const seat =
            room.players.findIndex(
              player =>
                player &&
                !player.bot &&
                player.socketId ===
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
                  socket.id,

                seat
              }
            );

          if (!room.started) {
            room.players[
              seat
            ] = null;

            room.hands[
              seat
            ] = [];

            if (
              socket.id ===
              room.hostId
            ) {
              const newHost =
                firstHumanPlayer(
                  room
                );

              if (newHost) {
                room.hostId =
                  newHost.socketId;
              } else {
                clearBotTimer(
                  room
                );

                rooms.delete(
                  room.code
                );

                continue;
              }
            }
          }

          else {
            player.connected =
              false;

            room.message =
              `${player.name} s-a deconectat.`;
          }

          sendState(room);
        }
      }
    );
  }
);

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Șeptică 3v3 rulează pe portul ${PORT}`
    );
  }
);
