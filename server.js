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

const BOT_DELAY = 2000;
const BOT_DECISION_DELAY = 1500;

/* =====================================================
   GENERAL
===================================================== */

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [
      array[j],
      array[i]
    ];
  }
}

function makeDeck() {
  const deck = [];

  // 4 x 7
  for (const suit of suits) {
    deck.push({
      rank: "7",
      suit
    });
  }

  // doar 2 x 8
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

  // câte 4 din restul
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

function isCut(
  card,
  openingRank
) {
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

function firstFreeSeat(room) {
  return room.players.findIndex(
    player =>
      player === null
  );
}

function playerCount(room) {
  return room.players
    .filter(Boolean)
    .length;
}

function teamCount(
  room,
  team
) {
  return room.players
    .filter(
      player =>
        player &&
        player.team === team
    )
    .length;
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

function nextSeat(seat) {
  return (
    seat + 1
  ) % 6;
}

/* =====================================================
   PUBLIC STATE
===================================================== */

function publicState(room) {
  return {
    hostId:
      room.hostId,

    started:
      room.started,

    gameFinished:
      room.gameFinished,

    players:
      room.players.map(
        player => {

          if (!player) {
            return null;
          }

          return {
            name:
              player.name,

            team:
              player.team,

            connected:
              player.connected,

            bot:
              !!player.bot
          };
        }
      ),

    handCounts:
      room.hands.map(
        hand =>
          hand.length
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

    turn:
      room.turn,

    opener:
      room.opener,

    openingRank:
      room.openingRank,

    table:
      room.table,

    trick:
      room.table,

    awaitingDecision:
      room.awaitingDecision,

    continuationMode:
      room.continuationMode,

    lastResult:
      room.lastResult,

    history:
      room.history,

    roundNumber:
      room.roundNumber,

    message:
      room.message
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

/* =====================================================
   GAME HELPERS
===================================================== */

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

/* =====================================================
   FINAL PARTIDĂ
===================================================== */

function finishGame(room) {
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

  const loserPiles =
    loserTeam === 1
      ? room.piles1
      : room.piles2;

  const loserPoints =
    loserTeam === 1
      ? room.cardPoints1
      : room.cardPoints2;

  let special = "";

  /*
    PIELE =
    echipa pierzătoare
    nu a luat nicio grămadă.
  */

  if (loserPiles === 0) {
    special = "PIELE";
  }

  /*
    BUZĂ =
    echipa pierzătoare
    a luat grămezi,
    dar doar caraboabe,
    deci 0 puncte.
  */

  else if (
    loserPoints === 0
  ) {
    special = "BUZĂ";
  }

  room.lastResult =
    special
      ? `Echipa ${loserTeam}: ${special}`
      : `Echipa ${winnerTeam} câștigă partida`;

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
   FINAL RUNDĂ / GRĂMADĂ
===================================================== */

function finishPile(room) {
  const points =
    countPoints(room.table);

  const winnerSeat =
    room.lastCutter;

  const winnerPlayer =
    room.players[winnerSeat];

  const winnerTeam =
    winnerPlayer.team;

  if (winnerTeam === 1) {
    room.cardPoints1 +=
      points;

    room.piles1++;
  } else {
    room.cardPoints2 +=
      points;

    room.piles2++;
  }

  /*
    SALVĂM ISTORICUL
  */

  room.history.push({
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
      points > 0
        ? `${points} punct${points === 1 ? "" : "e"} în grămadă.`
        : "0 puncte în grămadă."
    );

  room.table = [];

  room.openingRank =
    null;

  room.cardsInCycle =
    0;

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

  /*
    Jucătorul care a făcut
    ultima tăiere începe
    următoarea rundă.
  */

  room.roundNumber++;

  room.opener =
    winnerSeat;

  room.turn =
    winnerSeat;

  room.controlTeam =
    winnerTeam;

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

  /*
    După 6 cărți,
    opener-ul decide
    doar dacă poate continua.
  */

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
   START PARTIDĂ INTERN
===================================================== */

function startCurrentGame(room) {
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

  room.cardPoints1 =
    0;

  room.cardPoints2 =
    0;

  room.piles1 =
    0;

  room.piles2 =
    0;

  room.table =
    [];

  room.history =
    [];

  room.roundNumber =
    1;

  room.cardsInCycle =
    0;

  room.awaitingDecision =
    false;

  room.continuationMode =
    false;

  room.openingRank =
    null;

  /*
    Doar prima rundă
    începe Seat 0.
  */

  room.opener =
    0;

  room.turn =
    0;

  room.controlTeam =
    room.players[0].team;

  room.lastCutter =
    null;

  room.gameFinished =
    false;

  room.lastResult =
    "";

  room.started =
    true;

  room.message =
    `${room.players[0].name} începe prima rundă.`;
}

/* =====================================================
   BOȚI
===================================================== */

function scheduleBot(room) {
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

  setTimeout(
    () => {
      runBot(room);
    },
    BOT_DELAY
  );
}

function runBot(room) {
  if (!room.started) {
    return;
  }

  const seat =
    room.turn;

  const bot =
    room.players[seat];

  if (
    !bot ||
    !bot.bot
  ) {
    return;
  }

  /*
    BOTUL DECIDE
  */

  if (
    room.awaitingDecision &&
    seat === room.opener
  ) {
    setTimeout(
      () => {

        if (
          !room.started ||
          !room.awaitingDecision
        ) {
          return;
        }

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
            `${bot.name} a ales să continue.`;

          sendState(room);

          setTimeout(
            () => {
              runBot(room);
            },
            BOT_DECISION_DELAY
          );

          return;
        }

        finishPile(room);

        sendState(room);

        scheduleBot(room);
      },
      BOT_DECISION_DELAY
    );

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

  /*
    Dacă e continuare,
    obligatoriu tăiere validă.
  */

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

    room.cardsInCycle =
      0;

    room.continuationMode =
      false;
  }

  /*
    Botul preferă o tăiere,
    dar nu instant.
  */

  else if (
    room.table.length > 0
  ) {
    const cuttingIndex =
      hand.findIndex(
        card =>
          isCut(
            card,
            room.openingRank
          )
      );

    if (
      cuttingIndex !== -1
    ) {
      index =
        cuttingIndex;
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

    room.controlTeam =
      bot.team;

    room.lastCutter =
      seat;
  }

  const cut =
    isCut(
      card,
      room.openingRank
    );

  if (cut) {
    room.controlTeam =
      bot.team;

    room.lastCutter =
      seat;

    room.message =
      `${bot.name} a tăiat. Echipa ${bot.team} are momentan cărțile.`;
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
   SOCKET
===================================================== */

io.on(
  "connection",
  socket => {

    /* =========================
       CREATE ROOM
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
            ok:
              false,

            error:
              "Alege Echipa 1 sau Echipa 2."
          });
        }

        const code =
          createRoomCode();

        const playerName =
          String(
            name || ""
          ).trim() ||
          "Jucător";

        const players =
          Array(6).fill(null);

        players[0] = {
          socketId:
            socket.id,

          name:
            playerName,

          team,

          connected:
            true,

          bot:
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

          turn:
            0,

          opener:
            0,

          openingRank:
            null,

          table:
            [],

          controlTeam:
            team,

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

          roundNumber:
            1,

          lastResult:
            "",

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
          ok:
            true,

          code,

          seat:
            0
        });

        sendState(room);
      }
    );

    /* =========================
       JOIN ROOM
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
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        if (
          room.started
        ) {
          return callback({
            ok:
              false,

            error:
              "Partida a început deja."
          });
        }

        if (
          team !== 1 &&
          team !== 2
        ) {
          return callback({
            ok:
              false,

            error:
              "Alege o echipă."
          });
        }

        if (
          teamCount(
            room,
            team
          ) >= 3
        ) {
          return callback({
            ok:
              false,

            error:
              `Echipa ${team} are deja 3 jucători.`
          });
        }

        const seat =
          firstFreeSeat(room);

        if (
          seat === -1
        ) {
          return callback({
            ok:
              false,

            error:
              "Camera este plină."
          });
        }

        const playerName =
          String(
            name || ""
          ).trim() ||
          "Jucător";

        room.players[
          seat
        ] = {
          socketId:
            socket.id,

          name:
            playerName,

          team,

          connected:
            true,

          bot:
            false
        };

        socket.join(
          code
        );

        room.message =
          `${playerCount(room)}/6 jucători la masă.`;

        callback({
          ok:
            true,

          code,

          seat
        });

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
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        if (
          room.started
        ) {
          return callback({
            ok:
              false,

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
            ok:
              false,

            error:
              "Echipă invalidă."
          });
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
          return callback({
            ok:
              false,

            error:
              "Nu ești în cameră."
          });
        }

        const player =
          room.players[
            seat
          ];

        if (
          player.team ===
          team
        ) {
          return callback({
            ok:
              true
          });
        }

        if (
          teamCount(
            room,
            team
          ) >= 3
        ) {
          return callback({
            ok:
              false,

            error:
              `Echipa ${team} este plină.`
          });
        }

        player.team =
          team;

        room.message =
          `${player.name} a trecut în Echipa ${team}.`;

        callback({
          ok:
            true
        });

        sendState(room);
      }
    );

    /* =========================
       BOȚI + START AUTOMAT
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
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        if (
          socket.id !==
          room.hostId
        ) {
          return callback({
            ok:
              false,

            error:
              "Doar host-ul poate porni testul."
          });
        }

        if (
          room.started
        ) {
          return callback({
            ok:
              false,

            error:
              "Partida este deja pornită."
          });
        }

        /*
          Umplem exact până la
          3 vs 3.
        */

        for (
          let team = 1;
          team <= 2;
          team++
        ) {
          while (
            teamCount(
              room,
              team
            ) < 3
          ) {
            const seat =
              firstFreeSeat(
                room
              );

            if (
              seat === -1
            ) {
              break;
            }

            room.players[
              seat
            ] = {
              socketId:
                null,

              name:
                `Bot ${seat + 1}`,

              team,

              connected:
                true,

              bot:
                true
            };
          }
        }

        if (
          !teamsAreValid(
            room
          )
        ) {
          return callback({
            ok:
              false,

            error:
              "Nu s-au putut forma echipe 3 vs 3."
          });
        }

        startCurrentGame(
          room
        );

        callback({
          ok:
            true
        });

        sendState(room);

        scheduleBot(room);
      }
    );

    /* =========================
       START NORMAL
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
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        if (
          socket.id !==
          room.hostId
        ) {
          return callback({
            ok:
              false,

            error:
              "Doar host-ul poate porni."
          });
        }

        if (
          playerCount(room) !==
          6
        ) {
          return callback({
            ok:
              false,

            error:
              "Trebuie să fie 6 jucători."
          });
        }

        if (
          !teamsAreValid(
            room
          )
        ) {
          return callback({
            ok:
              false,

            error:
              "Trebuie să fie exact 3 jucători în fiecare echipă."
          });
        }

        startCurrentGame(
          room
        );

        callback({
          ok:
            true
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

        if (!room) {
          return callback({
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        const seat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          seat !==
            room.opener ||
          !room.awaitingDecision
        ) {
          return callback({
            ok:
              false,

            error:
              "Nu poți decide acum."
          });
        }

        if (
          !openerHasContinuation(
            room
          )
        ) {
          return callback({
            ok:
              false,

            error:
              "Nu ai cu ce continua."
          });
        }

        room.awaitingDecision =
          false;

        room.continuationMode =
          true;

        room.turn =
          room.opener;

        room.message =
          `${room.players[seat].name} continuă runda.`;

        callback({
          ok:
            true
        });

        sendState(room);
      }
    );

    /* =========================
       STOP ROUND
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

        if (!room) {
          return callback({
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        const seat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId ===
                socket.id
          );

        if (
          seat !==
            room.opener ||
          !room.awaitingDecision
        ) {
          return callback({
            ok:
              false,

            error:
              "Nu poți opri acum."
          });
        }

        finishPile(
          room
        );

        callback({
          ok:
            true
        });

        sendState(room);

        scheduleBot(room);
      }
    );

    /* =========================
       PLAY CARD
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
            ok:
              false,

            error:
              "Camera nu există."
          });
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
          return callback({
            ok:
              false,

            error:
              "Nu ești în cameră."
          });
        }

        if (
          !room.started ||
          seat !== room.turn
        ) {
          return callback({
            ok:
              false,

            error:
              "Nu este rândul tău."
          });
        }

        if (
          room.awaitingDecision
        ) {
          return callback({
            ok:
              false,

            error:
              "Alege Continuă sau Oprește."
          });
        }

        const hand =
          room.hands[
            seat
          ];

        index =
          Number(index);

        if (
          !Number.isInteger(
            index
          ) ||
          index < 0 ||
          index >=
            hand.length
        ) {
          return callback({
            ok:
              false,

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
              ok:
                false,

              error:
                `Trebuie ${room.openingRank}, 7 sau 8.`
            });
          }

          room.cardsInCycle =
            0;

          room.continuationMode =
            false;
        }

        hand.splice(
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

          room.controlTeam =
            room.players[
              seat
            ].team;

          room.lastCutter =
            seat;
        }

        const cut =
          isCut(
            card,
            room.openingRank
          );

        if (cut) {
          room.controlTeam =
            room.players[
              seat
            ].team;

          room.lastCutter =
            seat;

          room.message =
            `${room.players[seat].name} a tăiat. Echipa ${room.controlTeam} are momentan mâna.`;
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
          ok:
            true
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

        if (!room) {
          return callback?.({
            ok:
              false,

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
          return callback?.({
            ok:
              false,

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
            ok:
              false,

            error:
              "Mesaj gol."
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
          ok:
            true
        });
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
            ok:
              false,

            error:
              "Camera nu există."
          });
        }

        if (
          socket.id !==
          room.hostId
        ) {
          return callback({
            ok:
              false,

            error:
              "Doar host-ul poate da afară."
          });
        }

        if (
          room.started
        ) {
          return callback({
            ok:
              false,

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
            ok:
              false,

            error:
              "Loc liber."
          });
        }

        if (
          player.socketId ===
          room.hostId
        ) {
          return callback({
            ok:
              false,

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

        room.message =
          `${player.name} a fost scos din cameră.`;

        callback({
          ok:
            true
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

          if (
            !room.started
          ) {
            room.players[
              seat
            ] = null;

            room.message =
              `${player.name} a ieșit din cameră.`;

            if (
              socket.id ===
              room.hostId
            ) {
              const newHost =
                firstHumanPlayer(
                  room
                );

              if (
                newHost
              ) {
                room.hostId =
                  newHost.socketId;
              } else {
                rooms.delete(
                  room.code
                );

                continue;
              }
            }

            sendState(room);
          } else {
            player.connected =
              false;

            room.message =
              `${player.name} s-a deconectat.`;

            sendState(room);
          }
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
