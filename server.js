const express = require('express');

const http = require('http');

const { Server } = require('socket.io');

const path = require('path');



const app = express();

const server = http.createServer(app);

const io = new Server(server);



app.use(express.static(path.join(__dirname, 'public')));



let rooms = {};



io.on('connection', (socket) => {

    socket.on('joinRoom', (roomID) => {

        socket.join(roomID);

        if (!rooms[roomID]) {

            rooms[roomID] = { players: [], turn: 'red' };

        }



        if (rooms[roomID].players.length < 2) {

            const color = rooms[roomID].players.length === 0 ? 'red' : 'black';

            rooms[roomID].players.push({ id: socket.id, color });

            socket.emit('playerAssign', { color, roomID });

           

            if (rooms[roomID].players.length === 2) {

                io.to(roomID).emit('startGame', 'red'); // Vermelho começa

            }

        } else {

            socket.emit('errorMsg', 'Esta sala já está cheia!');

        }

    });



    socket.on('movePiece', (data) => {

        // Validação básica de turno no servidor para segurança

        if (rooms[data.room] && rooms[data.room].turn === data.color) {

            rooms[data.room].turn = data.color === 'red' ? 'black' : 'red';

            io.to(data.room).emit('moveUpdate', {

                ...data,

                nextTurn: rooms[data.room].turn

            });

        }

    });



    socket.on('disconnect', () => {

        // Limpeza de sala simplificada

        for (let r in rooms) {

            rooms[r].players = rooms[r].players.filter(p => p.id !== socket.id);

        }

    });

});



const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Jogo online na porta ${PORT}`);
});