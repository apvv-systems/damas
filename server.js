const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ====== 25 SALAS FIXAS ======
const ROOM_CODES = Array.from({ length: 25 }, (_, i) => `SALA-${String(i + 1).padStart(2, '0')}`);
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

function hasCaptureFrom(board, r, c) {
  const piece = board[r][c];
  if (!piece) return false;

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
  // room.board é a fonte da verdade
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

  // Jogada simples: 1 diagonal
  const isSimple = Math.abs(dr) === 1 && Math.abs(dc) === 1;
  // Captura: 2 diagonal
  const isCapture = Math.abs(dr) === 2 && Math.abs(dc) === 2;

  // Regras de direção (peça comum não pode andar/capturar pra trás)
  if (!piece.king) {
    if (piece.color === 'red' && dr >= 0) return { ok: false, error: 'Peça vermelha não pode andar para trás.' };
    if (piece.color === 'black' && dr <= 0) return { ok: false, error: 'Peça preta não pode andar para trás.' };
  }

  // Se está em mustContinue, só pode captura (não pode jogada simples)
  if (room.mustContinue && !isCapture) {
    return { ok: false, error: 'Você deve continuar capturando (combo).' };
  }

  let captured = null;

  if (isSimple) {
    // permitido: só movimento simples
    // aplica
    board[fromR][fromC] = null;
    board[toR][toC] = piece;

    // promoção
    let promoted = false;
    if (shouldPromote(piece, toR)) {
      piece.king = true;
      promoted = true;
    }

    // após jogada simples: nunca continua
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

    // aplica captura
    board[fromR][fromC] = null;
    board[midR][midC] = null;
    board[toR][toC] = piece;

    captured = { r: midR, c: midC };

    // promoção
    let promoted = false;
    if (shouldPromote(piece, toR)) {
      piece.king = true;
      promoted = true;
    }

    // multi-captura: se ainda dá pra capturar com essa peça, continua
    const canContinue = hasCaptureFrom(board, toR, toC);
    room.mustContinue = canContinue;
    room.continueFrom = canContinue ? { r: toR, c: toC } : null;

    return { ok: true, captured, promoted, fromR, fromC, toR, toC };
  }

  return { ok: false, error: 'Movimento inválido: só diagonal.' };
}

// Pré-cria as 25 salas (fixas)
for (const code of ROOM_CODES) {
  rooms[code] = {
    players: [],
    turn: 'red',
    board: createInitialBoard(),
    mustContinue: false,
    continueFrom: null,
  };
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (roomID) => {
    const raw = String(roomID || '').trim().toUpperCase();

    // só aceita as 25 salas
    if (!rooms[raw]) {
      socket.emit('errorMsg', 'Código inválido. Use SALA-01 até SALA-25.');
      return;
    }

    socket.join(raw);

    // se jogador já está na lista, não duplica (segurança)
    rooms[raw].players = rooms[raw].players.filter(p => p.id !== socket.id);

    if (rooms[raw].players.length < 2) {
      const color = rooms[raw].players.length === 0 ? 'red' : 'black';
      rooms[raw].players.push({ id: socket.id, color });
      socket.emit('playerAssign', { color, roomID: raw });

      if (rooms[raw].players.length === 2) {
        rooms[raw].turn = 'red'; // Vermelho começa
        rooms[raw].mustContinue = false;
        rooms[raw].continueFrom = null;

        io.to(raw).emit('startGame', 'red');
      }
    } else {
      socket.emit('errorMsg', 'Esta sala já está cheia!');
    }
  });

  socket.on('movePiece', (data) => {
    // segurança básica
    const roomCode = String(data?.room || '').trim().toUpperCase();
    const color = data?.color;

    if (!rooms[roomCode]) return;

    const room = rooms[roomCode];

    // turno do servidor manda
    if (room.turn !== color) {
      socket.emit('errorMsg', 'Não é seu turno.');
      return;
    }

    // valida e aplica regras de damas
    const result = validateAndApplyMove(room, color, data.from, data.to);
    if (!result.ok) {
      socket.emit('errorMsg', result.error || 'Movimento inválido.');
      return;
    }

    // se NÃO está em multi-captura, troca turno
    if (!room.mustContinue) {
      room.turn = color === 'red' ? 'black' : 'red';
    } else {
      // continua o mesmo jogador
      room.turn = color;
    }

    io.to(roomCode).emit('moveUpdate', {
      room: roomCode,
      color,
      from: { r: result.fromR, c: result.fromC },
      to: { r: result.toR, c: result.toC },
      captured: result.captured,        // {r,c} ou null
      promoted: result.promoted,        // true/false
      mustContinue: room.mustContinue,  // true/false
      continueFrom: room.continueFrom,  // {r,c} ou null
      nextTurn: room.turn
    });
  });

  socket.on('disconnect', () => {
    // Limpeza de sala simplificada (mantém sua estrutura)
    for (let r in rooms) {
      rooms[r].players = rooms[r].players.filter(p => p.id !== socket.id);
      // opcional: se sala ficar vazia, pode resetar board (NÃO fiz pra não mudar comportamento sem você pedir)
      // if (rooms[r].players.length === 0) rooms[r].board = createInitialBoard();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Jogo online na porta ${PORT}`);
});
