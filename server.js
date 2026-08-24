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
  // J1/J3/J5 = Echipa 1
  // J2/J4/J6 = Echipa 2
  return seat % 2 === 0 ? 1 : 2;
}

function makeDeck() {
  const deck = [];

  // 4 x 7
  for (const suit of suits) {
    deck.push({ rank: '7', suit });
  }

  // DOAR 2 x 8
  const shuffledSuits = [...suits].sort(() => Math.random() - 0.5);

  deck.push({ rank: '8', suit: shuffledSuits[0] });
  deck.push({ rank: '8', suit: shuffledSuits[1] });

  // 9, 10, J, Q, K, A = câte 4
  for (const rank of ['9', '10', 'J', 'Q', 'K', 'A']) {
    for (const suit of suits) {
      deck.push({ rank, suit });
    }
  }

  // Total = 30 cărți
  shuffle(deck);

  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }
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

function countPoints(cards) {
  return cards.reduce((total, x) => {
    return total + (isPoint(x.card) ? 1 : 0);
  }, 0);
}

function createCode() {
  let code;

  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));

  return code;
}

function publicState(room) {
  return {
    hostId: room.hostId,

    started: room.started,

    players: room.players.map((p, i) => ({
      name: p.name,
      team: teamOf(i),
      connected: p.connected
    })),

    handCounts: room.hands.map(h => h.length),

    scoreA: room.score1,
    scoreB: room.score2,

    turn: room.turn,

    dealer: room.dealer,

    opener: room.opener,

    openingRank: room.openingRank,

    trick: room.table,

    message: room.message
  };
}

function sendState(room) {
  io.to(room.code).emit('state', publicState(room));

  room.players.forEach((player, seat) => {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit(
        'hand',
        room.hands[seat] || []
      );
    }
  });
}

function playerHasContinuation(room) {
  const hand = room.hands[room.opener];

  return hand.some(card =>
    isCut(card, room.openingRank)
  );
}

function finishPile(room) {
  const points = countPoints(room.table);

  if (room.controlTeam === 1) {
    room.score1 += points;
  } else {
    room.score2 += points;
  }

  room.message =
    `Echipa ${room.controlTeam} a luat cărțile` +
    (points > 0
      ? ` și primește ${points} punct${points === 1 ? '' : 'e'}.`
      : '.');

  const winnerTeam = room.controlTeam;

  room.table = [];
  room.openingRank = null;
  room.cardsInCycle = 0;
  room.awaitingContinuation = false;

  // Următoarea mână începe un jucător din echipa
  // care a câștigat grămada.
  //
  // Folosim ultimul jucător care a tăiat.
  let nextOpener = room.lastCutter;

  if (
    nextOpener === null ||
    teamOf(nextOpener) !== winnerTeam
  ) {
    nextOpener = room.opener;
  }

  room.opener = nextOpener;
  room.turn = nextOpener;

  checkGameEnd(room);
}

function checkGameEnd(room) {
  const noCards = room.hands.every(hand => hand.length === 0);

  if (!noCards) {
    return false;
  }

  room.started = false;

  if (room.score1 > room.score2) {
    room.message =
      `JOC TERMINAT — Echipa 1 câștigă ${room.score1}-${room.score2}!`;
  } else if (room.score2 > room.score1) {
    room.message =
      `JOC TERMINAT — Echipa 2 câștigă ${room.score2}-${room.score1}!`;
  } else {
    room.message =
      `JOC TERMINAT — egalitate ${room.score1}-${room.score2}.`;
  }

  return true;
}

function afterCard(room) {
  // Nu s-au pus încă 6 cărți în ciclul actual.
  if (room.cardsInCycle < 6) {
    room.turn = (room.turn + 1) % 6;
    return;
  }

  // S-au pus 6 cărți.
  // Jucătorul care a deschis mâna poate continua
  // numai cu 7, 8 sau aceeași valoare ca prima carte.
  if (playerHasContinuation(room)) {
    room.awaitingContinuation = true;
    room.turn = room.opener;

    room.message =
      `Jucătorul ${room.opener + 1} poate continua ` +
      `cu ${room.openingRank}, 7 sau 8.`;

    return;
  }

  // Nu poate continua => ultima echipă care controlează
  // mâna ia toate cărțile.
  finishPile(room);
}

io.on('connection', socket => {

  socket.on('createRoom', ({ name }, callback) => {
    const playerName =
      String(name || '').trim() || 'Jucător 1';

    const code = createCode();

    const room = {
      code,

      hostId: socket.id,

      players: [
        {
          socketId: socket.id,
          name: playerName,
          connected: true
        }
      ],

      hands: [[], [], [], [], [], []],

      started: false,

      score1: 0,
      score2: 0,

      dealer: 0,

      opener: 0,
      turn: 0,

      openingRank: null,

      table: [],

      controlTeam: 1,
      lastCutter: null,

      cardsInCycle: 0,
      awaitingContinuation: false,

      message: 'Așteptăm 6 jucători.'
    };

    rooms.set(code, room);

    socket.join(code);

    callback({
      ok: true,
      code,
      seat: 0
    });

    sendState(room);
  });

  socket.on('joinRoom', ({ code, name }, callback) => {
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

    if (room.players.length === 6) {
      room.message =
        'Toți cei 6 jucători sunt la masă. Host-ul poate porni jocul.';
    } else {
      room.message =
        `${room.players.length}/6 jucători la masă.`;
    }

    callback({
      ok: true,
      code,
      seat
    });

    sendState(room);
  });

  socket.on('startGame', ({ code }, callback) => {
    const room = rooms.get(String(code));

    if (!room) {
      return callback({
        ok: false,
        error: 'Camera nu există.'
      });
    }

    if (socket.id !== room.hostId) {
      return callback({
        ok: false,
        error: 'Doar host-ul poate porni jocul.'
      });
    }

    if (room.players.length !== 6) {
      return callback({
        ok: false,
        error: 'Trebuie să fie exact 6 jucători.'
      });
    }

    const deck = makeDeck();

    room.hands = [[], [], [], [], [], []];

    // 30 cărți / 6 jucători = 5 fiecare
    for (let round = 0; round < 5; round++) {
      for (let seat = 0; seat < 6; seat++) {
        room.hands[seat].push(deck.pop());
      }
    }

    room.score1 = 0;
    room.score2 = 0;

    room.table = [];

    room.openingRank = null;

    room.cardsInCycle = 0;

    room.awaitingContinuation = false;

    room.lastCutter = null;

    // Dealer = Jucător 1 la prima partidă.
    room.dealer = 0;

    /*
      Ordinea este:
      J1 -> J2 -> J3 -> J4 -> J5 -> J6

      Jucătorul din dreapta dealerului începe.
      Dacă dealer = J1, dreapta lui este J6.
    */
    room.opener = 5;
    room.turn = 5;

    room.controlTeam = teamOf(room.opener);

    room.started = true;

    room.message =
      `Jucătorul ${room.opener + 1} începe jocul.`;

    callback({ ok: true });

    sendState(room);
  });

  socket.on('playCard', ({ code, index }, callback) => {
    const room = rooms.get(String(code));

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

    const seat = room.players.findIndex(
      p => p.socketId === socket.id
    );

    if (seat === -1) {
      return callback({
        ok: false,
        error: 'Nu ești în această cameră.'
      });
    }

    if (seat !== room.turn) {
      return callback({
        ok: false,
        error: 'Nu este rândul tău.'
      });
    }

    const hand = room.hands[seat];

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
      După ce s-au jucat 6 cărți,
      numai jucătorul care a deschis poate continua
      și TREBUIE să pună:
      - aceeași valoare ca prima carte
      - 7
      - 8
    */
    if (room.awaitingContinuation) {
      if (seat !== room.opener) {
        return callback({
          ok: false,
          error: 'Doar jucătorul care a deschis poate continua.'
        });
      }

      if (!isCut(card, room.openingRank)) {
        return callback({
          ok: false,
          error:
            `Poți continua doar cu ${room.openingRank}, 7 sau 8.`
        });
      }

      room.awaitingContinuation = false;
      room.cardsInCycle = 0;
    }

    // Scoatem cartea din mână
    hand.splice(index, 1);

    // Prima carte a întregii mâini
    if (room.table.length === 0) {
      room.openingRank = card.rank;

      room.opener = seat;

      room.controlTeam = teamOf(seat);

      room.lastCutter = seat;

      room.message =
        `Jucătorul ${seat + 1} a deschis cu ${card.rank}.`;
    }

    const cutting = isCut(
      card,
      room.openingRank
    );

    if (cutting) {
      room.controlTeam = teamOf(seat);
      room.lastCutter = seat;

      room.message =
        `Jucătorul ${seat + 1} a tăiat. ` +
        `Echipa ${room.controlTeam} are momentan mâna.`;
    }

    room.table.push({
      player: seat,
      card,
      cut: cutting
    });

    room.cardsInCycle++;

    afterCard(room);

    callback({ ok: true });

    sendState(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find(
        p => p.socketId === socket.id
      );

      if (!player) continue;

      player.connected = false;

      room.message =
        `${player.name} s-a deconectat.`;

      sendState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Șeptică 3v3 rulează pe portul ${PORT}`);
});
