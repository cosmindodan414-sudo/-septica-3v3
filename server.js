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
const suits = ['♠','♥','♦','♣'];
const ranks = ['7','8','9','10','J','Q','K','A'];

function makeDeck(){
  const d=[];
  for(const s of suits) for(const r of ranks) d.push({rank:r,suit:s});
  for(let i=d.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}
function teamOf(p){ return p%2===0 ? 'A' : 'B'; }
function isPoint(c){ return c.rank==='10' || c.rank==='A'; }
function publicState(room){
  return {
    code: room.code,
    started: room.started,
    hostId: room.hostId,
    players: room.players.map((p,i)=>({id:p.id,name:p.name,seat:i,team:teamOf(i),connected:p.connected})),
    turn: room.turn,
    leader: room.leader,
    trick: room.trick,
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    winner: room.winner,
    message: room.message,
    handCounts: room.hands?.map(h=>h.length) || []
  };
}
function emitRoom(room){
  io.to(room.code).emit('state', publicState(room));
  room.players.forEach((p,i)=>{
    io.to(p.id).emit('hand', room.hands?.[i] || []);
  });
}
function genCode(){
  let c;
  do c = Math.floor(100000+Math.random()*900000).toString(); while(rooms.has(c));
  return c;
}

io.on('connection', socket => {
  socket.on('createRoom', ({name}, cb) => {
    const code=genCode();
    const room={code,hostId:socket.id,players:[{id:socket.id,name:name||'J1',connected:true}],started:false,hands:[],turn:0,leader:0,trick:[],scoreA:0,scoreB:0,winner:null,message:'Așteptăm 6 jucători.'};
    rooms.set(code,room);
    socket.join(code);
    cb?.({ok:true,code,seat:0});
    emitRoom(room);
  });

  socket.on('joinRoom', ({code,name}, cb) => {
    const room=rooms.get(String(code));
    if(!room) return cb?.({ok:false,error:'Camera nu există.'});
    if(room.started) return cb?.({ok:false,error:'Jocul a început deja.'});
    if(room.players.length>=6) return cb?.({ok:false,error:'Camera este plină.'});
    const seat=room.players.length;
    room.players.push({id:socket.id,name:name||`J${seat+1}`,connected:true});
    socket.join(room.code);
    cb?.({ok:true,code:room.code,seat});
    room.message = room.players.length===6 ? 'Toți cei 6 jucători sunt conectați.' : `Așteptăm jucători: ${room.players.length}/6`;
    emitRoom(room);
  });

  socket.on('startGame', ({code}, cb) => {
    const room=rooms.get(String(code));
    if(!room) return cb?.({ok:false,error:'Camera nu există.'});
    if(room.hostId!==socket.id) return cb?.({ok:false,error:'Doar host-ul poate porni jocul.'});
    if(room.players.length!==6) return cb?.({ok:false,error:'Trebuie să fie exact 6 jucători.'});
    const deck=makeDeck();
    room.hands=Array.from({length:6},()=>[]);
    // 5 cărți fiecare; 2 rămân nefolosite în această variantă inițială.
    for(let r=0;r<5;r++) for(let p=0;p<6;p++) room.hands[p].push(deck.pop());
    room.started=true; room.turn=0; room.leader=0; room.trick=[]; room.scoreA=0; room.scoreB=0; room.winner=null; room.message='J1 începe.';
    cb?.({ok:true});
    emitRoom(room);
  });

  socket.on('playCard', ({code,index}, cb) => {
    const room=rooms.get(String(code));
    if(!room || !room.started) return cb?.({ok:false,error:'Jocul nu este pornit.'});
    const seat=room.players.findIndex(p=>p.id===socket.id);
    if(seat<0) return cb?.({ok:false,error:'Nu ești în această cameră.'});
    if(room.turn!==seat) return cb?.({ok:false,error:'Nu este rândul tău.'});
    const hand=room.hands[seat];
    if(index<0 || index>=hand.length) return cb?.({ok:false,error:'Carte invalidă.'});
    const card=hand.splice(index,1)[0];
    const first=room.trick[0]?.card;
    const cut = !first ? true : (card.rank==='7' || card.rank===first.rank);
    room.trick.push({player:seat,card,cut});

    if(room.trick.length===6){
      let winner=room.leader;
      for(let i=1;i<room.trick.length;i++) if(room.trick[i].cut) winner=room.trick[i].player;
      const points=room.trick.reduce((s,x)=>s+(isPoint(x.card)?1:0),0);
      if(teamOf(winner)==='A') room.scoreA+=points; else room.scoreB+=points;
      room.message=`J${winner+1} ia mâna (+${points} puncte).`;
      room.leader=winner; room.turn=winner; room.trick=[];
      if(room.hands.every(h=>h.length===0)){
        room.started=false;
        room.winner = room.scoreA===room.scoreB ? 'Egalitate' : (room.scoreA>room.scoreB ? 'Echipa A' : 'Echipa B');
        room.message=`Final: A ${room.scoreA} - ${room.scoreB} B. ${room.winner}.`;
      }
    } else {
      room.turn=(room.turn+1)%6;
      room.message=`Rândul lui J${room.turn+1}.`;
    }
    cb?.({ok:true});
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    for(const room of rooms.values()){
      const p=room.players.find(p=>p.id===socket.id);
      if(p){ p.connected=false; room.message=`${p.name} s-a deconectat.`; emitRoom(room); }
    }
  });
});

const PORT=process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`Șeptică 3v3 rulează pe http://localhost:${PORT}`));
