import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const suits = ['♠', '♥', '♦', '♣'];

function teamOf(seat) {
  // Jucătorii 1, 3, 5 = Echipa 1
  // Jucătorii 2, 4, 6 = Echipa 2
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

  // 4 șeptari
  for (const suit of suits) {
    deck.push({
      rank: '7',
      suit
    });
  }

  // Doar 2 optari în joc
  const randomSuits = [...suits];
  shuffle(randomSuits);

  deck.push({
    rank: '8',
    suit: randomSuits[0]
  });

  deck.push({
    rank: '8',
    suit: randomSuits[1]
  });

  // Restul cărților: câte 4
  for (const rank of ['9', '10', 'J', 'Q', 'K', 'A']) {
    for (const suit of suits) {
      deck.push({
        rank,
        suit
      });
    }
  }

  // Total: 30 cărți
  // 30 / 6 = 5 cărți fiecare
  shuffle(deck);

  return deck;
}

function isPoint(card) {
  return card.rank === '10' || card.rank === 'A';
}

function isCut(card, openingRank) {
  return (
    card.rank === '7' ||
    card.rank === '8' ||
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

function publicState(room) {
  return {
    hostId: room.hostId,

    started: room.started,

    players: room.players.map((player, index) => ({
      name: player.name,
      team: teamOf(index),
      connected: player.connected
    })),

    handCounts: room.hands.map(hand => hand.length),

    scoreA: room.score1,
    scoreB: room.score2,

    turn: room.turn,

    opener: room.opener,

    openingRank: room.openingRank,

    table: room.table,
    trick: room.table,

    message: room.message,

    waitingForOpener: room.waitingForOpener
  };
}

function sendState(room) {
  io.to(room.code).emit(
    'state',
    publicState(room)
  );

  room.players.forEach((player, seat) => {
    if (
      player.connected &&
      player.socketId
    ) {
      io.to(player.socketId).emit(
        'hand',
        room.hands[seat] || []
      );
    }
  });
}

function openerCanContinue(room) {
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

function finishGame(room) {
  room.started = false;

  if (room.score1 > room.score2) {
    room.message =
      `JOC TERMINAT — Echipa 1 câștigă cu ${room.score1}-${room.score2}!`;
  } else if (room.score2 > room.score1) {
    room.message =
      `JOC TERMINAT — Echipa 2 câștigă cu ${room.score2}-${room.score1}!`;
  } else {
    room.message =
      `JOC TERMINAT — Egalitate ${room.score1}-${room.score2}.`;
  }
}

function finishPile(room) {
  const points = countPoints(room.table);

  if (room.controlTeam === 1) {
    room.score1 += points;
  } else {
    room.score2 += points;
  }

  const winningTeam = room.controlTeam;
  const lastCutter = room.lastCutter;

  room.message =
    `Echipa ${winningTeam} a luat cărțile` +
    (points > 0
      ? ` și primește ${points} punct${points === 1 ? '' : 'e'}.`
      : '.');

  room.table = [];
  room.openingRank = null;

  room.cardsInCycle = 0;
  room.waitingForOpener = false;

  if (gameIsFinished(room)) {
    finishGame(room);
    return;
  }

  /*
    Următoarea mână începe jucătorul
    care a făcut ultima tăiere.
  */
  if (lastCutter !== null) {
    room.opener = lastCutter;
    room.turn = lastCutter;
  }

  room.controlTeam = teamOf(room.opener);
  room.lastCutter = room.opener;
}

function afterCardPlayed(room) {
  /*
    Într-un ciclu normal trebuie să joace
    toți cei 6 jucători.
  */
  if (room.cardsInCycle < 6) {
    room.turn = (room.turn + 1) % 6;
    return;
  }

  /*
    După ce toți 6 au pus câte o carte,
    jucătorul care a început mâna poate continua
    dacă are:
    - aceeași valoare ca prima carte
    - 7
    - 8
  */
  if (openerCanContinue(room)) {
    room.waitingForOpener = true;
    room.turn = room.opener;

    room.message =
      `Jucătorul ${room.opener + 1} poate continua cu ` +
      `${room.openingRank}, 7 sau 8.`;

    return;
  }

  /*
    Dacă nu poate continua,
    echipa care are ultima tăiere ia toate cărțile.
  */
  finishPile(room);
}

io.on('connection', socket => {

  socket.on(
    'createRoom',
    ({ name }, callback) => {

      const roomCode = createRoomCode();

      const playerName =
        String(name || '').trim() ||
        'Jucător 1';

      const room = {
        code: roomCode,

        hostId: socket.id,

        players: [
          {
            socketId: socket.id,
            name: playerName,
            connected: true
          }
        ],

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

        waitingForOpener: false,

        message:
          'Așteptăm ceilalți jucători.'
      };

      rooms.set(
        roomCode,
        room
      );

      socket.join(roomCode);

      callback({
        ok: true,
        code: roomCode,
        seat: 0
      });

      sendState(room);
    }
  );

  socket.on(
    'joinRoom',
    ({ code, name }, callback) => {

      code = String(code || '').trim();

      const room = rooms.get(code);

      if (!room) {
        return callback({
          ok: false,
          error: 'Camera nu există.'
        });
      }

      if (room.started) {
        return callback({
          ok: false,
          error: 'Jocul a început deja.'
        });
      }

      if (room.players.length >= 6) {
        return callback({
          ok: false,
          error: 'Camera este plină.'
        });
      }

      const seat = room.players.length;

      const playerName =
        String(name || '').trim() ||
        `Jucător ${seat + 1}`;

      room.players.push({
        socketId: socket.id,
        name: playerName,
        connected: true
      });

      socket.join(code);

      room.message =
        room.players.length === 6
          ? 'Toți cei 6 jucători sunt la masă.'
          : `${room.players.length}/6 jucători la masă.`;

      callback({
        ok: true,
        code,
        seat
      });

      sendState(room);
    }
  );

  socket.on(
    'startGame',
    ({ code }, callback) => {

      const room = rooms.get(
        String(code)
      );

      if (!room) {
        return callback({
          ok: false,
          error: 'Camera nu există.'
        });
      }

      if (socket.id !== room.hostId) {
        return callback({
          ok: false,
          error:
            'Doar host-ul poate porni jocul.'
        });
      }

      if (room.players.length !== 6) {
        return callback({
          ok: false,
          error:
            'Trebuie să fie exact 6 jucători.'
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
        Fiecare jucător primește 5 cărți.
      */
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
          room.hands[seat].push(
            deck.pop()
          );
        }
      }

      room.score1 = 0;
      room.score2 = 0;

      room.table = [];

      room.cardsInCycle = 0;

      room.waitingForOpener = false;

      room.openingRank = null;

      /*
        Prima versiune:
        Jucătorul 1 începe.

        Dacă vrei mai târziu,
        putem adăuga dealer + tăiere pachet
        și jucătorul din dreapta dealerului.
      */
      room.opener = 0;
      room.turn = 0;

      room.controlTeam = 1;
      room.lastCutter = null;

      room.started = true;

      room.message =
        'Jucătorul 1 începe jocul.';

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  socket.on(
    'playCard',
    ({ code, index }, callback) => {

      const room = rooms.get(
        String(code)
      );

      if (!room) {
        return callback({
          ok: false,
          error: 'Camera nu există.'
        });
      }

      if (!room.started) {
        return callback({
          ok: false,
          error: 'Jocul nu a început.'
        });
      }

      const seat =
        room.players.findIndex(
          player =>
            player.socketId === socket.id
        );

      if (seat === -1) {
        return callback({
          ok: false,
          error:
            'Nu ești în această cameră.'
        });
      }

      if (seat !== room.turn) {
        return callback({
          ok: false,
          error:
            'Nu este rândul tău.'
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
          error: 'Carte invalidă.'
        });
      }

      const card = hand[index];

      /*
        Dacă s-au jucat deja 6 cărți,
        numai jucătorul care a început mâna
        poate continua.
      */
      if (room.waitingForOpener) {

        if (seat !== room.opener) {
          return callback({
            ok: false,
            error:
              'Doar jucătorul care a început poate continua.'
          });
        }

        if (
          !isCut(
            card,
            room.openingRank
          )
        ) {
          return callback({
            ok: false,
            error:
              `Trebuie să joci ${room.openingRank}, 7 sau 8.`
          });
        }

        /*
          Începe încă un ciclu de 6 cărți.
        */
        room.waitingForOpener = false;
        room.cardsInCycle = 0;
      }

      /*
        Scoatem cartea din mâna jucătorului.
      */
      hand.splice(index, 1);

      /*
        Prima carte din întreaga mână.
      */
      if (room.table.length === 0) {

        room.opener = seat;

        room.openingRank =
          card.rank;

        room.controlTeam =
          teamOf(seat);

        room.lastCutter =
          seat;

        room.message =
          `Jucătorul ${seat + 1} a deschis cu ${card.rank}.`;
      }

      const cut =
        isCut(
          card,
          room.openingRank
        );

      /*
        Dacă jucătorul taie,
        echipa lui are momentan cărțile.
      */
      if (cut) {

        room.controlTeam =
          teamOf(seat);

        room.lastCutter =
          seat;

        room.message =
          `Jucătorul ${seat + 1} a tăiat. ` +
          `Echipa ${room.controlTeam} are momentan mâna.`;
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

  /*
    HOST — DĂ AFARĂ JUCĂTOR
  */
  socket.on(
    'kickPlayer',
    ({ code, seat }, callback) => {

      const room = rooms.get(
        String(code)
      );

      if (!room) {
        return callback({
          ok: false,
          error: 'Camera nu există.'
        });
      }

      /*
        Numai host-ul poate da kick.
      */
      if (socket.id !== room.hostId) {
        return callback({
          ok: false,
          error:
            'Doar host-ul poate da afară jucători.'
        });
      }

      /*
        Nu permitem kick după ce partida a început.
      */
      if (room.started) {
        return callback({
          ok: false,
          error:
            'Nu poți da afară jucători după ce jocul a început.'
        });
      }

      seat = Number(seat);

      if (
        !Number.isInteger(seat) ||
        seat < 0 ||
        seat >= room.players.length
      ) {
        return callback({
          ok: false,
          error:
            'Jucător invalid.'
        });
      }

      /*
        Host-ul este primul jucător.
        Nu se poate da singur afară.
      */
      if (seat === 0) {
        return callback({
          ok: false,
          error:
            'Host-ul nu se poate da singur afară.'
        });
      }

      const kickedPlayer =
        room.players[seat];

      /*
        Trimitem mesaj jucătorului dat afară.
      */
      if (
        kickedPlayer &&
        kickedPlayer.socketId
      ) {
        io
          .to(kickedPlayer.socketId)
          .emit('kicked');
      }

      /*
        Eliminăm jucătorul.
      */
      room.players.splice(
        seat,
        1
      );

      room.message =
        `${kickedPlayer.name} a fost dat afară din cameră.`;

      callback({
        ok: true
      });

      sendState(room);
    }
  );

  socket.on(
    'disconnect',
    () => {

      for (
        const room of rooms.values()
      ) {

        const player =
          room.players.find(
            p =>
              p.socketId === socket.id
          );

        if (!player) {
          continue;
        }

        player.connected = false;

        room.message =
          `${player.name} s-a deconectat.`;

        sendState(room);
      }
    }
  );
});

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
