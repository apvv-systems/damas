const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ====== 25 SALAS: ORDEM + ALEATORIEDADE ======
function randCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // evita 0/O e 1/I
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const ROOM_CODES = Array.from({ length: 25 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `SALA-${n}-${randCode(4)}`; // ex: SALA-01-K7Q4
});

const rooms = {}; // mantém o mesmo nome que você já usa

function createInitialBoard() {
  // board[r][c] = null | { color: 'red'|'black', king: boolean }
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 !== 0) {
        if (r < 3) board[r][c] = { color: 'black', king: false };
        if (r > 4) board[r][c] = { color: 'red', king: false };
      }
    }
  }
  return board;
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function getDirs(piece) {
  // dama pode ir em qualquer diagonal
  if (piece.king) {
    return [
      [-1, -1], [-1, 1],
      [ 1, -1], [ 1, 1],
    ];
  }
  // peça comum: só pra frente
  return piece.color === 'red'
    ? [[-1, -1], [-1, 1]]
    : [[ 1, -1], [ 1, 1]];
}

function shouldPromote(piece, toR) {
  return !piece.king && (
    (piece.color === 'red' && toR === 0) ||
    (piece.color === 'black' && toR === 7)
  );
}

// ====== DAMA VOADORA: CAPTURAS LONGAS ======
function getFlyingKingCaptures(board, r, c) {
  const piece = board[r][c];
  if (!piece || !piece.king) return [];

  const dirs = getDirs(piece);
  const moves = [];

  for (const [dr, dc] of dirs) {
    let rr = r + dr;
    let cc = c + dc;

    // varre vazios até encontrar algo
    while (inBounds(rr, cc) && !board[rr][cc]) {
      rr += dr;
      cc += dc;
    }

    // se saiu do tabuleiro ou achou amiga, sem captura
    if (!inBounds(rr, cc)) continue;
    if (board[rr][cc] && board[rr][cc].color === piece.color) continue;

    // achou inimigo
    const capR = rr;
    const capC = cc;

    // agora as casas de pouso precisam ser vazias depois do inimigo
    rr += dr;
    cc += dc;

    while (inBounds(rr, cc) && !board[rr][cc]) {
      moves.push({ toR: rr, toC: cc, capR, capC });
      rr += dr;
      cc += dc;
    }
  }

  return moves;
}

function hasCaptureFrom(board, r, c) {
  const piece = board[r][c];
  if (!piece) return false;

  // dama voadora
  if (piece.king) {
    return getFlyingKingCaptures(board, r, c).length > 0;
  }

  // peça comum (curta)
  const dirs = getDirs(piece);
  for (const [dr, dc] of dirs) {
    const midR = r + dr;
    const midC = c + dc;
    const toR  = r + dr * 2;
    const toC  = c + dc * 2;

    if (!inBounds(midR, midC) || !inBounds(toR, toC)) continue;

    const mid = board[midR][midC];
    const landing = board[toR][toC];

    if (mid && mid.color !== piece.color && !landing) return true;
  }
  return false;
}

function validateAndApplyMove(room, color, from, to) {
  const board = room.board;

  const fromR = parseInt(from.r, 10);
  const fromC = parseInt(from.c, 10);
  const toR = parseInt(to.r, 10);
  const toC = parseInt(to.c, 10);

  if (!inBounds(fromR, fromC) || !inBounds(toR, toC)) {
    return { ok: false, error: 'Movimento fora do tabuleiro.' };
  }

  const piece = board[fromR][fromC];
  if (!piece) return { ok: false, error: 'Sem peça na origem.' };
  if (piece.color !== color) return { ok: false, error: 'Essa peça não é sua.' };
  if (board[toR][toC]) return { ok: false, error: 'Destino ocupado.' };

  // Se está em sequência de multi-captura, obriga continuar com a mesma peça
  if (room.mustContinue) {
    if (!room.continueFrom) return { ok: false, error: 'Estado inválido de continuação.' };
    if (fromR !== room.continueFrom.r || fromC !== room.continueFrom.c) {
      return { ok: false, error: 'Você deve continuar capturando com a mesma peça.' };
    }
  }

  const dr = toR - fromR;
  const dc = toC - fromC;

  // ====== DAMA VOADORA: MOVIMENTO LONGO + CAPTURA LONGA ======
  if (piece.king) {
    if (Math.abs(dr) !== Math.abs(dc) || dr === 0) {
      return { ok: false, error: 'Dama só anda na diagonal.' };
    }

    const stepR = dr > 0 ? 1 : -1;
    const stepC = dc > 0 ? 1 : -1;

    let r = fromR + stepR;
    let c = fromC + stepC;

    let enemySeen = null;

    // varre ENTRE origem e destino
    while (r !== toR && c !== toC) {
      const cell = board[r][c];

      if (cell) {
        if (cell.color === piece.color) {
          return { ok: false, error: 'Caminho bloqueado.' };
        }
        if (enemySeen) {
          return { ok: false, error: 'Captura inválida.' };
        }
        enemySeen = { r, c };
      }

      r += stepR;
      c += stepC;
    }

    // Se está em mustContinue, dama só pode capturar
    if (room.mustContinue && !enemySeen) {
      return { ok: false, error: 'Você deve continuar capturando (combo).' };
    }

    // Movimento simples (sem captura)
    if (!enemySeen) {
      board[fromR][fromC] = null;
      board[toR][toC] = piece;

      room.mustContinue = false;
      room.continueFrom = null;

      return { ok: true, captured: null, promoted: false, fromR, fromC, toR, toC };
    }

    // Captura longa
    board[fromR][fromC] = null;
    board[enemySeen.r][enemySeen.c] = null;
    board[toR][toC] = piece;

    const captured = { r: enemySeen.r, c: enemySeen.c };

    const canContinue = hasCaptureFrom(board, toR, toC);
    room.mustContinue = canContinue;
    room.continueFrom = canContinue ? { r: toR, c: toC } : null;

    return { ok: true, captured, promoted: false, fromR, fromC, toR, toC };
  }

  // ====== PEÇA COMUM (curta) ======
  const isSimple = Math.abs(dr) === 1 && Math.abs(dc) === 1;
  const isCapture = Math.abs(dr) === 2 && Math.abs(dc) === 2;

  // direção: peça comum não pode andar/capturar pra trás
  if (!piece.king) {
    if (piece.color === 'red' && dr >= 0) return { ok: false, error: 'Peça vermelha não pode andar para trás.' };
    if (piece.color === 'black' && dr <= 0) return { ok: false, error: 'Peça preta não pode andar para trás.' };
  }

  if (room.mustContinue && !isCapture) {
    return { ok: false, error: 'Você deve continuar capturando (combo).' };
  }

  let captured = null;

  if (isSimple) {
    board[fromR][fromC] = null;
    board[toR][toC] = piece;

    let promoted = false;
    if (shouldPromote(piece, toR)) {
      piece.king = true;
      promoted = true;
    }

    room.mustContinue = false;
    room.continueFrom = null;

    return { ok: true, captured, promoted, fromR, fromC, toR, toC };
  }

  if (isCapture) {
    const midR = fromR + dr / 2;
    const midC = fromC + dc / 2;
    const mid = board[midR][midC];

    if (!mid || mid.color === piece.color) {
      return { ok: false, error: 'Captura inválida.' };
    }

    board[fromR][fromC] = null;
    board[midR][midC] = null;
    board[toR][toC] = piece;

    captured = { r: midR, c: midC };

    let promoted = false;
    if (shouldPromote(piece, toR)) {
      piece.king = true;
      promoted = true;
    }

    const canContinue = hasCaptureFrom(board, toR, toC);
    room.mustContinue = canContinue;
    room.continueFrom = canContinue ? { r: toR, c: toC } : null;

    return { ok: true, captured, promoted, fromR, fromC, toR, toC };
  }

  return { ok: false, error: 'Movimento inválido: só diagonal.' };
}

// Pré-cria as 25 salas (ordenadas + aleatórias)
for (const code of ROOM_CODES) {
  rooms[code] = {
    players: [],
    turn: 'red',
    board: createInitialBoard(),
    mustContinue: false,
    continueFrom: null,
  };
}

// mostra os códigos no Render Logs
console.log('🎟️ Salas disponíveis:');
ROOM_CODES.forEach(c => console.log(' -', c));

io.on('connection', (socket) => {
  socket.on('joinRoom', (roomID) => {
    const raw = String(roomID || '').trim().toUpperCase();

    if (!rooms[raw]) {
      socket.emit('errorMsg', 'Código inválido. Use um código válido (ex: SALA-01-XXXX).');
      return;
    }

    socket.join(raw);

    rooms[raw].players = rooms[raw].players.filter(p => p.id !== socket.id);

    if (rooms[raw].players.length < 2) {
      const color = rooms[raw].players.length === 0 ? 'red' : 'black';
      rooms[raw].players.push({ id: socket.id, color });
      socket.emit('playerAssign', { color, roomID: raw });

      if (rooms[raw].players.length === 2) {
        rooms[raw].turn = 'red';
        rooms[raw].mustContinue = false;
        rooms[raw].continueFrom = null;

        io.to(raw).emit('startGame', 'red');
      }
    } else {
      socket.emit('errorMsg', 'Esta sala já está cheia!');
    }
  });

  socket.on('movePiece', (data) => {
    const roomCode = String(data?.room || '').trim().toUpperCase();
    const color = data?.color;

    if (!rooms[roomCode]) return;

    const room = rooms[roomCode];

    if (room.turn !== color) {
      socket.emit('errorMsg', 'Não é seu turno.');
      return;
    }

    const result = validateAndApplyMove(room, color, data.from, data.to);
    if (!result.ok) {
      socket.emit('errorMsg', result.error || 'Movimento inválido.');
      return;
    }

    if (!room.mustContinue) {
      room.turn = color === 'red' ? 'black' : 'red';
    } else {
      room.turn = color;
    }

    io.to(roomCode).emit('moveUpdate', {
      room: roomCode,
      color,
      from: { r: result.fromR, c: result.fromC },
      to: { r: result.toR, c: result.toC },
      captured: result.captured,
      promoted: result.promoted,
      mustContinue: room.mustContinue,
      continueFrom: room.continueFrom,
      nextTurn: room.turn
    });
  });

  socket.on('disconnect', () => {
    for (let r in rooms) {
      rooms[r].players = rooms[r].players.filter(p => p.id !== socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Jogo online na porta ${PORT}`);
});
