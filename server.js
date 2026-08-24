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

  // 4 x 7
  for (const suit of suits) {
    deck.push({ rank: "7", suit });
  }

  // doar 2 x 8
  const eightSuits = [...suits];
  shuffle(eightSuits);

  deck.push({ rank: "8", suit: eightSuits[0] });
  deck.push({ rank: "8", suit: eightSuits[1] });

  // 4 x 9,10,J,Q,K,A
  for (const rank of ["9", "10", "J", "Q", "K", "A"]) {
    for (const suit of suits) {
      deck.push({ rank, suit });
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
  return table.reduce(
    (sum, play) => sum + (isPoint(play.card) ? 1 : 0),
    0
  );
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
  return room.players.findIndex(p => p === null);
}

function playerCount(room) {
  return room.players.filter(Boolean).length;
}

function firstHumanPlayer(room) {
  return room.players.find(
    p => p && !p.bot && p.connected
  );
}

function publicState(room) {
  return {
    hostId: room.hostId,
    started: room.started,

    players: room.players.map((player, index) => {
      if (!player) return null;

      return {
        name: player.name,
        team: teamOf(index),
        connected: player.connected,
        bot: !!player.bot
      };
    }),

    handCounts: room.hands.map(h => h.length),

    scoreA: room.score1,
    scoreB: room.score2,

    turn: room.turn,
    opener: room.opener,
    openingRank: room.openingRank,

    table: room.table,
    trick: room.table,

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
      !player.bot &&
      player.connected &&
      player.socketId
    ) {
      io.to(player.socketId).emit(
        "hand",
        room.hands[seat]
      );

      io.to(player.socketId).emit(
        "seat",
        seat
      );
    }
  });
}

function openerHasContinuation(room) {
  if (room.opener === null) return false;

  return room.hands[room.opener].some(
    card => isCut(card, room.openingRank)
  );
}

function gameIsFinished(room) {
  return room.hands.every(hand => hand.length === 0);
}

/* =====================================================
   GAME END
===================================================== */

function finishGame(room) {
  room.started = false;
  room.awaitingDecision = false;
  room.continuationMode = false;

  if (room.score1 > room.score2) {
    room.message =
      `Joc terminat — Echipa 1 câștigă ${room.score1}-${room.score2}!`;
  } else if (room.score2 > room.score1) {
    room.message =
      `Joc terminat — Echipa 2 câștigă ${room.score2}-${room.score1}!`;
  } else {
    room.message =
      `Joc terminat — egalitate ${room.score1}-${room.score2}.`;
  }
}

/* =====================================================
   FINISH ROUND
===================================================== */

function finishPile(room) {
  const points = countPoints(room.table);
  const winnerTeam = room.controlTeam;
  const winnerSeat = room.lastCutter;

  if (winnerTeam === 1) {
    room.score1 += points;
  } else {
    room.score2 += points;
  }

  const winner =
    room.players[winnerSeat];

  room.message =
    `${winner?.name || "Jucătorul"} a luat cărțile pentru Echipa ${winnerTeam}` +
    (points
      ? ` și primește ${points} punct${points === 1 ? "" : "e"}.`
      : ".");

  room.table = [];
  room.openingRank = null;
  room.cardsInCycle = 0;
  room.awaitingDecision = false;
  room.continuationMode = false;

  if (gameIsFinished(room)) {
    finishGame(room);
    return;
  }

  // Cine a făcut ultima tăiere începe următoarea rundă.
  room.opener = winnerSeat;
  room.turn = winnerSeat;
  room.controlTeam = teamOf(winnerSeat);
  room.lastCutter = winnerSeat;
}

/* =====================================================
   AFTER CARD
===================================================== */

function afterCardPlayed(room) {
  if (room.cardsInCycle < 6) {
    room.turn = (room.turn + 1) % 6;
    return;
  }

  // După 6 cărți, opener-ul poate alege dacă are tăiere.
  if (openerHasContinuation(room)) {
    room.awaitingDecision = true;
    room.continuationMode = false;
    room.turn = room.opener;

    room.message =
      `${room.players[room.opener].name} poate continua sau opri runda.`;

    return;
  }

  // Nu mai are cu ce continua.
  finishPile(room);
}

/* =====================================================
   BOT
===================================================== */

function scheduleBot(room) {
  if (!room.started) return;

  const current = room.players[room.turn];

  if (!current || !current.bot) return;

  setTimeout(() => {
    runBot(room);
  }, 650);
}

function runBot(room) {
  if (!room.started) return;

  const seat = room.turn;
  const bot = room.players[seat];

  if (!bot || !bot.bot) return;

  /* BOT DECIDE CONTINUE / STOP */

  if (
    room.awaitingDecision &&
    seat === room.opener
  ) {
    if (openerHasContinuation(room)) {
      // Pentru test, botul continuă dacă poate.
      room.awaitingDecision = false;
      room.continuationMode = true;

      room.message =
        `${bot.name} continuă runda.`;

      sendState(room);

      setTimeout(() => runBot(room), 500);
      return;
    }

    finishPile(room);
    sendState(room);
    scheduleBot(room);
    return;
  }

  const hand = room.hands[seat];

  if (!hand || hand.length === 0) return;

  let index = 0;

  /* Dacă continuă, trebuie să aleagă tăiere validă */

  if (room.continuationMode) {
    index = hand.findIndex(
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

  /*
    Bot simplu:
    dacă poate tăia, preferă o carte de tăiere.
    Altfel pune prima carte.
  */

  if (room.table.length > 0) {
    const cuttingIndex =
      hand.findIndex(
        card =>
          isCut(
            card,
            room.openingRank
          )
      );

    if (cuttingIndex !== -1) {
      index = cuttingIndex;
    }
  }

  const card = hand[index];

  hand.splice(index, 1);

  if (room.table.length === 0) {
    room.opener = seat;
    room.openingRank = card.rank;
    room.controlTeam = teamOf(seat);
    room.lastCutter = seat;
  }

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
      `${bot.name} a tăiat. Echipa ${room.controlTeam} are momentan mâna.`;
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

  scheduleBot(room);
}

/* =====================================================
   SOCKET
===================================================== */

io.on("connection", socket => {

  /* CREATE */

  socket.on(
    "createRoom",
    ({ name }, callback) => {

      const code =
        createRoomCode();

      const playerName =
        String(name || "").trim() ||
        "Jucător 1";

      const players =
        Array(6).fill(null);

      players[0] = {
        socketId: socket.id,
        name: playerName,
        connected: true,
        bot: false
      };

      const room = {
        code,

        hostId: socket.id,

        players,

        hands: Array.from(
          { length: 6 },
          () => []
        ),

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

  /* JOIN */

  socket.on(
    "joinRoom",
    ({ code, name }, callback) => {

      code =
        String(code || "").trim();

      const room =
        rooms.get(code);

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

      const seat =
        firstFreeSeat(room);

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
        connected: true,
        bot: false
      };

      socket.join(code);

      room.message =
        `${playerCount(room)}/6 jucători la masă.`;

      callback({
        ok: true,
        code,
        seat
      });

      sendState(room);
    }
  );

  /* FILL WITH BOTS */

  socket.on(
    "fillWithBots",
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
          error: "Doar host-ul poate adăuga boți."
        });
      }

      if (room.started) {
        return callback({
          ok: false,
          error: "Jocul a început deja."
        });
      }

      for (let seat = 0; seat < 6; seat++) {
        if (!room.players[seat]) {
          room.players[seat] = {
            socketId: null,
            name: `Bot ${seat + 1}`,
            connected: true,
            bot: true
          };
        }
      }

      room.message =
        "Boții au fost adăugați. Poți porni jocul.";

      callback({ ok: true });

      sendState(room);
    }
  );

  /* START */

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
          error: "Trebuie să fie 6 jucători."
        });
      }

      const deck = makeDeck();

      room.hands =
        Array.from(
          { length: 6 },
          () => []
        );

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

      room.opener = 0;
      room.turn = 0;

      room.controlTeam = 1;
      room.lastCutter = null;

      room.started = true;

      room.message =
        `${room.players[0].name} începe prima rundă.`;

      callback({ ok: true });

      sendState(room);

      scheduleBot(room);
    }
  );

  /* CONTINUE */

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

      const seat =
        room.players.findIndex(
          p =>
            p &&
            p.socketId === socket.id
        );

      if (
        seat !== room.opener ||
        !room.awaitingDecision
      ) {
        return callback({
          ok: false,
          error: "Nu poți decide acum."
        });
      }

      if (!openerHasContinuation(room)) {
        return callback({
          ok: false,
          error: "Nu ai cu ce continua."
        });
      }

      room.awaitingDecision = false;
      room.continuationMode = true;
      room.turn = room.opener;

      room.message =
        `${room.players[seat].name} continuă runda.`;

      callback({ ok: true });

      sendState(room);
    }
  );

  /* STOP */

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
          p =>
            p &&
            p.socketId === socket.id
        );

      if (
        seat !== room.opener ||
        !room.awaitingDecision
      ) {
        return callback({
          ok: false,
          error: "Nu poți opri acum."
        });
      }

      finishPile(room);

      callback({ ok: true });

      sendState(room);
      scheduleBot(room);
    }
  );

  /* PLAY */

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

      const seat =
        room.players.findIndex(
          p =>
            p &&
            p.socketId === socket.id
        );

      if (seat === -1) {
        return callback({
          ok: false,
          error: "Nu ești în cameră."
        });
      }

      if (
        !room.started ||
        seat !== room.turn
      ) {
        return callback({
          ok: false,
          error: "Nu este rândul tău."
        });
      }

      if (room.awaitingDecision) {
        return callback({
          ok: false,
          error:
            "Mai întâi alege Continuă sau Oprește."
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

      const card = hand[index];

      if (room.continuationMode) {
        if (!isCut(card, room.openingRank)) {
          return callback({
            ok: false,
            error:
              `Trebuie ${room.openingRank}, 7 sau 8.`
          });
        }

        room.cardsInCycle = 0;
        room.continuationMode = false;
      }

      hand.splice(index, 1);

      if (room.table.length === 0) {
        room.opener = seat;
        room.openingRank = card.rank;

        room.controlTeam =
          teamOf(seat);

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
          teamOf(seat);

        room.lastCutter =
          seat;

        room.message =
          `${room.players[seat].name} a tăiat. Echipa ${room.controlTeam} are momentan mâna.`;
      } else {
        room.message =
          `${room.players[seat].name} a jucat ${card.rank}${card.suit}.`;
      }

      room.table.push({
        player: seat,
        card,
        cut
      });

      room.cardsInCycle++;

      afterCardPlayed(room);

      callback({ ok: true });

      sendState(room);
      scheduleBot(room);
    }
  );

  /* CHAT */

  socket.on(
    "chatMessage",
    ({ code, text }, callback) => {

      const room =
        rooms.get(String(code));

      if (!room) {
        return callback?.({
          ok: false,
          error: "Camera nu există."
        });
      }

      const seat =
        room.players.findIndex(
          p =>
            p &&
            !p.bot &&
            p.socketId === socket.id
        );

      if (seat === -1) {
        return callback?.({
          ok: false,
          error: "Nu ești în această cameră."
        });
      }

      text =
        String(text || "")
          .trim()
          .slice(0, 200);

      if (!text) {
        return callback?.({
          ok: false,
          error: "Mesaj gol."
        });
      }

      io.to(room.code).emit(
        "chatMessage",
        {
          name: room.players[seat].name,
          seat,
          text
        }
      );

      callback?.({ ok: true });
    }
  );

  /* KICK */

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
          error: "Doar host-ul poate da kick."
        });
      }

      if (room.started) {
        return callback({
          ok: false,
          error: "Jocul a început deja."
        });
      }

      seat = Number(seat);

      const player =
        room.players[seat];

      if (!player) {
        return callback({
          ok: false,
          error: "Loc liber."
        });
      }

      if (player.socketId === room.hostId) {
        return callback({
          ok: false,
          error: "Host-ul nu se poate scoate."
        });
      }

      if (!player.bot && player.socketId) {
        io.to(player.socketId).emit(
          "kicked"
        );
      }

      room.players[seat] = null;
      room.hands[seat] = [];

      room.message =
        `${player.name} a fost scos din cameră.`;

      callback({ ok: true });

      sendState(room);
    }
  );

  /* DISCONNECT */

  socket.on("disconnect", () => {

    for (const room of rooms.values()) {

      const seat =
        room.players.findIndex(
          p =>
            p &&
            !p.bot &&
            p.socketId === socket.id
        );

      if (seat === -1) continue;

      const player =
        room.players[seat];

      if (!room.started) {
        room.players[seat] = null;

        room.message =
          `${player.name} a ieșit din cameră.`;

        if (socket.id === room.hostId) {
          const newHost =
            firstHumanPlayer(room);

          if (newHost) {
            room.hostId =
              newHost.socketId;
          } else {
            rooms.delete(room.code);
            continue;
          }
        }

        sendState(room);
      } else {
        player.connected = false;

        room.message =
          `${player.name} s-a deconectat.`;

        sendState(room);
      }
    }
  });
});

const PORT =
  process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Șeptică 3v3 rulează pe portul ${PORT}`
  );
});
