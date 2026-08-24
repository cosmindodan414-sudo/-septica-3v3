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

/* =====================================================
   HELPERS
===================================================== */

function teamOf(seat) {
  // J1, J3, J5 = Echipa 1
  // J2, J4, J6 = Echipa 2
  return seat % 2 === 0 ? 1 : 2;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function makeDeck() {
  const deck = [];

  // 4 de 7
  for (const suit of suits) {
    deck.push({
      rank: "7",
      suit
    });
  }

  // Doar 2 de 8
  const randomSuits = [...suits];
  shuffle(randomSuits);

  deck.push({
    rank: "8",
    suit: randomSuits[0]
  });

  deck.push({
    rank: "8",
    suit: randomSuits[1]
  });

  // 9, 10, J, Q, K, A = câte 4
  for (const rank of ["9", "10", "J", "Q", "K", "A"]) {
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
  return card.rank === "10" || card.rank === "A";
}

function isCut(card, openingRank) {
  return (
    card.rank === "7" ||
    card.rank === "8" ||
    card.rank === openingRank
  );
}

function countPoints(table) {
  let points = 0;

  for (const play of table) {
    if (isPoint(play.card)) {
      points++;
    }
  }

  return points;
}

function createRoomCode() {
  let code;

  do {
    code = String(
      Math.floor(100000 + Math.random() * 900000)
    );
  } while (rooms.has(code));

  return code;
}

function firstFreeSeat(room) {
  return room.players.findIndex(player => player === null);
}

function playerCount(room) {
  return room.players.filter(Boolean).length;
}

function firstConnectedPlayer(room) {
  return room.players.find(
    player => player && player.connected
  );
}

function nextSeat(currentSeat) {
  return (currentSeat + 1) % 6;
}

function publicState(room) {
  return {
    hostId: room.hostId,

    started: room.started,

    players: room.players.map((player, index) => {
      if (!player) {
        return null;
      }

      return {
        name: player.name,
        team: teamOf(index),
        connected: player.connected
      };
    }),

    handCounts: room.hands.map(hand => hand.length),

    scoreA: room.score1,
    scoreB: room.score2,

    turn: room.turn,

    opener: room.opener,

    openingRank: room.openingRank,

    table: room.table,
    trick: room.table,

    controlTeam: room.controlTeam,

    lastCutter: room.lastCutter,

    cardsInCycle: room.cardsInCycle,

    awaitingDecision: room.awaitingDecision,

    continuationMode: room.continuationMode,

    message: room.message
  };
}

function sendState(room) {
  io.to(room.code).emit(
    "state",
    publicState(room)
  );

  room.players.forEach((player, seat) => {
    if (
      player &&
      player.connected &&
      player.socketId
    ) {
      io.to(player.socketId).emit(
        "hand",
        room.hands[seat] || []
      );

      io.to(player.socketId).emit(
        "seat",
        seat
      );
    }
  });
}

function openerHasContinuation(room) {
  if (
    room.opener === null ||
    room.openingRank === null
  ) {
    return false;
  }

  const hand = room.hands[room.opener];

  return hand.some(card =>
    isCut(card, room.openingRank)
  );
}

function gameIsFinished(room) {
  return room.hands.every(
    hand => hand.length === 0
  );
}

/* =====================================================
   FINAL JOC
===================================================== */

function finishGame(room) {
  room.started = false;
  room.awaitingDecision = false;
  room.continuationMode = false;

  if (room.score1 > room.score2) {
    room.message =
      `JOC TERMINAT — Echipa 1 câștigă ${room.score1}-${room.score2}!`;
  } else if (room.score2 > room.score1) {
    room.message =
      `JOC TERMINAT — Echipa 2 câștigă ${room.score2}-${room.score1}!`;
  } else {
    room.message =
      `JOC TERMINAT — Egalitate ${room.score1}-${room.score2}.`;
  }
}

/* =====================================================
   FINAL RUNDA
===================================================== */

function finishPile(room) {
  const points = countPoints(room.table);

  const winningTeam = room.controlTeam;

  if (winningTeam === 1) {
    room.score1 += points;
  } else {
    room.score2 += points;
  }

  /*
    IMPORTANT:
    exact jucătorul care a făcut ultima tăiere
    începe următoarea rundă.
  */
  const winnerPlayer = room.lastCutter;

  const winnerName =
    winnerPlayer !== null &&
    room.players[winnerPlayer]
      ? room.players[winnerPlayer].name
      : `Jucător ${winnerPlayer + 1}`;

  room.message =
    `${winnerName} a luat cărțile pentru Echipa ${winningTeam}` +
    (
      points > 0
        ? ` — ${points} punct${points === 1 ? "" : "e"}.`
        : "."
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

  /*
    Ultimul cutter începe runda următoare.
  */
  room.opener = winnerPlayer;
  room.turn = winnerPlayer;

  room.controlTeam = teamOf(winnerPlayer);

  room.lastCutter = winnerPlayer;
}

/* =====================================================
   DUPĂ O CARTE
===================================================== */

function afterCardPlayed(room) {
  /*
    În fiecare ciclu joacă 6 cărți.
  */
  if (room.cardsInCycle < 6) {
    room.turn = nextSeat(room.turn);
    return;
  }

  /*
    Toți cei 6 au jucat.

    Acum verificăm dacă jucătorul care
    a început runda are:
    - aceeași carte ca prima
    - 7
    - 8
  */

  if (openerHasContinuation(room)) {
    /*
      NU continuăm automat.

      Jucătorul primește:
      CONTINUĂ RUNDA
      OPREȘTE RUNDA
    */
    room.awaitingDecision = true;

    room.continuationMode = false;

    room.turn = room.opener;

    const openerPlayer =
      room.players[room.opener];

    room.message =
      `${openerPlayer.name} poate continua runda sau o poate opri.`;

    return;
  }

  /*
    Dacă NU are nicio carte cu care să continue,
    runda se termină automat.
  */
  finishPile(room);
}

/* =====================================================
   SOCKET
===================================================== */

io.on("connection", socket => {

  /* ===================================================
     CREATE ROOM
  =================================================== */

  socket.on(
    "createRoom",
    ({ name }, callback) => {

      const code = createRoomCode();

      const playerName =
        String(name || "").trim() ||
        "Jucător 1";

      const players = [
        null,
        null,
        null,
        null,
        null,
        null
      ];

      players[0] = {
        socketId: socket.id,
        name: playerName,
        connected: true
      };

      const room = {
        code,

        hostId: socket.id,

        players,

        hands: [
          [],
          [],
          [],
          [],
          [],
          []
        ],

        started: false,

        score1: 0,
        score2: 0,

        turn: 0,

        opener: 0,

        openingRank: null,

        table: [],

        controlTeam: 1,

        lastCutter: null,

        cardsInCycle: 0,

        awaitingDecision: false,

        continuationMode: false,

        message: "1/6 jucători la masă."
      };

      rooms.set(code, room);

      socket.join(code);

      callback({
        ok: true,
        code,
        seat: 0
      });

      sendState(room);
    }
  );

  /* ===================================================
     JOIN ROOM
  =================================================== */

  socket.on(
    "joinRoom",
    ({ code, name }, callback) => {

      code = String(code || "").trim();

      const room = rooms.get(code);

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      if (room.started) {
        return callback({
          ok: false,
          error: "Jocul a început deja."
        });
      }

      const seat = firstFreeSeat(room);

      if (seat === -1) {
        return callback({
          ok: false,
          error: "Camera este plină."
        });
      }

      const playerName =
        String(name || "").trim() ||
        `Jucător ${seat + 1}`;

      room.players[seat] = {
        socketId: socket.id,
        name: playerName,
        connected: true
      };

      socket.join(code);

      const count = playerCount(room);

      room.message =
        count === 6
          ? "Toți cei 6 jucători sunt la masă."
          : `${count}/6 jucători la masă.`;

      callback({
        ok: true,
        code,
        seat
      });

      sendState(room);
    }
  );

  /* ===================================================
     START GAME
  =================================================== */

  socket.on(
    "startGame",
    ({ code }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      if (socket.id !== room.hostId) {
        return callback({
          ok: false,
          error: "Doar host-ul poate porni jocul."
        });
      }

      if (playerCount(room) !== 6) {
        return callback({
          ok: false,
          error: "Trebuie să fie exact 6 jucători."
        });
      }

      const deck = makeDeck();

      room.hands = [
        [],
        [],
        [],
        [],
        [],
        []
      ];

      /*
        30 cărți:
        5 pentru fiecare din cei 6 jucători.
      */
      for (let round = 0; round < 5; round++) {
        for (let seat = 0; seat < 6; seat++) {
          room.hands[seat].push(
            deck.pop()
          );
        }
      }

      room.score1 = 0;
      room.score2 = 0;

      room.table = [];

      room.cardsInCycle = 0;

      room.awaitingDecision = false;

      room.continuationMode = false;

      room.openingRank = null;

      /*
        Prima rundă începe Jucătorul 1.

        După aceea începe exact jucătorul
        care ia cărțile.
      */
      room.opener = 0;
      room.turn = 0;

      room.controlTeam = 1;

      room.lastCutter = null;

      room.started = true;

      room.message =
        `${room.players[0].name} începe prima rundă.`;

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  /* ===================================================
     CONTINUĂ RUNDA
  =================================================== */

  socket.on(
    "continueRound",
    ({ code }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      if (!room.started) {
        return callback({
          ok: false,
          error: "Jocul nu a început."
        });
      }

      const seat =
        room.players.findIndex(
          player =>
            player &&
            player.socketId === socket.id
        );

      if (seat !== room.opener) {
        return callback({
          ok: false,
          error:
            "Doar jucătorul care a început runda poate decide."
        });
      }

      if (!room.awaitingDecision) {
        return callback({
          ok: false,
          error:
            "Nu trebuie să alegi acum."
        });
      }

      if (!openerHasContinuation(room)) {
        return callback({
          ok: false,
          error:
            "Nu ai nicio carte cu care să continui."
        });
      }

      /*
        Acum jucătorul trebuie să aleagă din mână
        o carte validă:
        openingRank / 7 / 8.
      */
      room.awaitingDecision = false;

      room.continuationMode = true;

      room.turn = room.opener;

      room.message =
        `${room.players[seat].name} a ales să continue. Trebuie să joace ${room.openingRank}, 7 sau 8.`;

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  /* ===================================================
     OPREȘTE RUNDA
  =================================================== */

  socket.on(
    "stopRound",
    ({ code }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      const seat =
        room.players.findIndex(
          player =>
            player &&
            player.socketId === socket.id
        );

      if (seat !== room.opener) {
        return callback({
          ok: false,
          error:
            "Doar jucătorul care a început runda poate decide."
        });
      }

      if (!room.awaitingDecision) {
        return callback({
          ok: false,
          error:
            "Runda nu așteaptă o decizie."
        });
      }

      room.awaitingDecision = false;

      room.continuationMode = false;

      /*
        Echipa care are ultima tăiere
        ia toate cărțile.
      */
      finishPile(room);

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  /* ===================================================
     PLAY CARD
  =================================================== */

  socket.on(
    "playCard",
    ({ code, index }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      if (!room.started) {
        return callback({
          ok: false,
          error: "Jocul nu a început."
        });
      }

      const seat =
        room.players.findIndex(
          player =>
            player &&
            player.socketId === socket.id
        );

      if (seat === -1) {
        return callback({
          ok: false,
          error:
            "Nu ești în această cameră."
        });
      }

      /*
        Când așteptăm Continue / Stop,
        nu se poate pune carte direct.
      */
      if (room.awaitingDecision) {
        return callback({
          ok: false,
          error:
            "Mai întâi alege Continuă runda sau Oprește runda."
        });
      }

      if (seat !== room.turn) {
        return callback({
          ok: false,
          error: "Nu este rândul tău."
        });
      }

      const hand =
        room.hands[seat];

      index = Number(index);

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= hand.length
      ) {
        return callback({
          ok: false,
          error: "Carte invalidă."
        });
      }

      const card =
        hand[index];

      /*
        Dacă opener-ul a ales CONTINUĂ,
        cartea lui trebuie obligatoriu să fie:
        - aceeași valoare cu prima carte
        - 7
        - 8
      */
      if (room.continuationMode) {

        if (seat !== room.opener) {
          return callback({
            ok: false,
            error:
              "Doar jucătorul care a început poate continua."
          });
        }

        if (!isCut(card, room.openingRank)) {
          return callback({
            ok: false,
            error:
              `Poți continua doar cu ${room.openingRank}, 7 sau 8.`
          });
        }

        /*
          Începe un nou ciclu.
          Cartea opener-ului va fi prima din cele 6.
        */
        room.cardsInCycle = 0;

        room.continuationMode = false;
      }

      /*
        Scoatem cartea.
      */
      hand.splice(index, 1);

      /*
        Prima carte a unei runde NOI.
      */
      if (room.table.length === 0) {

        room.opener = seat;

        room.openingRank =
          card.rank;

        room.controlTeam =
          teamOf(seat);

        /*
          Dacă nimeni nu mai taie după el,
          opener-ul ia cărțile.
        */
        room.lastCutter =
          seat;

        room.message =
          `${room.players[seat].name} a deschis cu ${card.rank}.`;
      }

      /*
        Verificăm dacă această carte taie.
      */
      const cut =
        isCut(
          card,
          room.openingRank
        );

      if (cut) {
        room.controlTeam =
          teamOf(seat);

        room.lastCutter =
          seat;

        room.message =
          `${room.players[seat].name} a tăiat. Echipa ${room.controlTeam} are momentan cărțile.`;
      }

      room.table.push({
        player: seat,
        card,
        cut
      });

      room.cardsInCycle++;

      afterCardPlayed(room);

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  /* ===================================================
     KICK
  =================================================== */

  socket.on(
    "kickPlayer",
    ({ code, seat }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback({
          ok: false,
          error: "Camera nu există."
        });
      }

      if (socket.id !== room.hostId) {
        return callback({
          ok: false,
          error:
            "Doar host-ul poate da afară jucători."
        });
      }

      if (room.started) {
        return callback({
          ok: false,
          error:
            "Nu poți da afară jucători după ce partida a început."
        });
      }

      seat = Number(seat);

      if (
        !Number.isInteger(seat) ||
        seat < 0 ||
        seat > 5
      ) {
        return callback({
          ok: false,
          error: "Jucător invalid."
        });
      }

      const player =
        room.players[seat];

      if (!player) {
        return callback({
          ok: false,
          error:
            "Locul este deja liber."
        });
      }

      if (player.socketId === room.hostId) {
        return callback({
          ok: false,
          error:
            "Host-ul nu se poate da singur afară."
        });
      }

      io.to(player.socketId).emit(
        "kicked"
      );

      room.players[seat] = null;

      room.hands[seat] = [];

      room.message =
        `${player.name} a fost dat afară din cameră.`;

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  /* ===================================================
     DISCONNECT
  =================================================== */

  socket.on(
    "disconnect",
    () => {

      for (const room of rooms.values()) {

        const seat =
          room.players.findIndex(
            player =>
              player &&
              player.socketId === socket.id
          );

        if (seat === -1) {
          continue;
        }

        const player =
          room.players[seat];

        /*
          ÎNAINTE DE START:
          dispare complet și slotul devine liber.
        */
        if (!room.started) {

          room.players[seat] = null;

          room.hands[seat] = [];

          room.message =
            `${player.name} a ieșit din cameră.`;

          /*
            Dacă host-ul pleacă,
            alt jucător devine host.
          */
          if (socket.id === room.hostId) {

            const newHost =
              firstConnectedPlayer(room);

            if (newHost) {

              room.hostId =
                newHost.socketId;

              room.message +=
                ` ${newHost.name} este noul host.`;

            } else {

              rooms.delete(room.code);

              continue;
            }
          }

          sendState(room);

          continue;
        }

        /*
          DUPĂ START:
          nu îi ștergem cărțile.
        */
        player.connected = false;

        room.message =
          `${player.name} s-a deconectat.`;

        sendState(room);
      }
    }
  );
});

/* =====================================================
   START SERVER
===================================================== */

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Șeptică 3v3 rulează pe portul ${PORT}`
    );
  }
);
