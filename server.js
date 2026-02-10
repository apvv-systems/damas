const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Gerenciamento de 25 salas específicas
let rooms = {};
for (let i = 1; i <= 25; i++) {
    rooms[`SALA${i}`] = { players: [], turn: 'red', boardState: {} };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomID) => {
        const room = roomID.toUpperCase();
        if (!rooms[room]) {
            return socket.emit('errorMsg', 'Esta sala não existe. Use SALA1 a SALA25.');
        }

        if (rooms[room].players.length < 2) {
            const color = rooms[room].players.length === 0 ? 'red' : 'black';
            rooms[room].players.push({ id: socket.id, color });
            socket.join(room);
            socket.emit('playerAssign', { color, roomID: room });
            
            if (rooms[room].players.length === 2) {
                io.to(room).emit('startGame', 'red');
            }
        } else {
            socket.emit('errorMsg', 'Esta sala já está cheia!');
        }
    });

    socket.on('movePiece', (data) => {
        const room = rooms[data.room];
        if (room && room.turn === data.color) {
            // No servidor, apenas alternamos o turno e replicamos o movimento validado pelo cliente
            // Em um cenário de produção real, as regras de diagonal seriam re-validadas aqui.
            room.turn = data.color === 'red' ? 'black' : 'red';
            io.to(data.room).emit('moveUpdate', {
                ...data,
                nextTurn: room.turn
            });
        }
    });

    socket.on('disconnect', () => {
        for (let r in rooms) {
            rooms[r].players = rooms[r].players.filter(p => p.id !== socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor Sênior Ativo na porta ${PORT}`);
});