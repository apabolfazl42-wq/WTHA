// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Socket.io initialization with CORS for development
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;

// Serve static files (index.html, client.js, style.css)
app.use(express.static(path.join(__dirname, 'public')));

// Simple room state management (for video URL/time/state)
const rooms = {};

// Handle Socket.io connections
io.on('connection', (socket) => {
    console.log(User connected: ${socket.id});

    // --- LANDING PAGE / ROOM MANAGEMENT ---
    
    // Create a new room
    socket.on('createRoom', (username, callback) => {
        const roomId = uuidv4().substring(0, 6); // Short, unique ID
        socket.join(roomId);
        socket.data.username = username;
        rooms[roomId] = {
            host: socket.id,
            videoUrl: null,
            videoTime: 0,
            videoState: 'paused', // 'playing' or 'paused'
            users: [{ id: socket.id, username }]
        };
        console.log(Room created: ${roomId} by ${username});
        callback({ success: true, roomId, roomState: rooms[roomId] });
    });

    // Join an existing room
    socket.on('joinRoom', (roomId, username, callback) => {
        if (!rooms[roomId]) {
            return callback({ success: false, message: 'Room not found.' });
        }
        
        socket.join(roomId);
        socket.data.username = username;
        socket.data.roomId = roomId;

        rooms[roomId].users.push({ id: socket.id, username });
        
        console.log(${username} joined room: ${roomId});

        // Broadcast user joined
        socket.to(roomId).emit('userJoined', { id: socket.id, username });
        // Send current room state to the joining user
        callback({ success: true, roomId, roomState: rooms[roomId], users: rooms[roomId].users });
        // Send the updated user list to everyone in the room
        io.to(roomId).emit('updateUserList', rooms[roomId].users);
    });

    // --- TEXT CHAT ---
    
    socket.on('chatMessage', (message) => {
        const roomId = socket.data.roomId;
        if (roomId) {
            io.to(roomId).emit('newChatMessage', {
                username: socket.data.username || 'Guest',
                text: message,
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });

    // --- VIDEO SYNC ---
    
    // Initial video load (Host or first user to set)
    socket.on('loadVideo', (url, time) => {
        const roomId = socket.data.roomId;
        if (roomId) {
            rooms[roomId].videoUrl = url;
            rooms[roomId].videoTime = time || 0;
            rooms[roomId].videoState = 'paused';
            
            // Broadcast the new video URL and state to everyone in the room
            io.to(roomId).emit('videoLoaded', { url, time: rooms[roomId].videoTime, state: rooms[roomId].videoState });
        }
    });

    // Video action sync (play, pause, seek)
    socket.on('videoAction', (action, currentTime) => {
        const roomId = socket.data.roomId;
        if (roomId) {
            // Update server state (mainly for late joiners)
            rooms[roomId].videoTime = currentTime;
            rooms[roomId].videoState = action; 

            // Broadcast the event to all other clients
            socket.to(roomId).emit('videoEvent', { action, currentTime });
        }
    });

    // --- WebRTC SIGNALING ---

    // A user is offering a connection to another user (peerId)
    socket.on('webrtcOffer', (peerId, offer) => {
        socket.to(peerId).emit('webrtcOffer', socket.id, offer);
    });

    // A user is answering a connection from another user (peerId)
    socket.on('webrtcAnswer', (peerId, answer) => {
        socket.to(peerId).emit('webrtcAnswer', socket.id, answer);
    });

// Exchange ICE candidates for NAT traversal
    socket.on('webrtcIceCandidate', (peerId, candidate) => {
        socket.to(peerId).emit('webrtcIceCandidate', socket.id, candidate);
    });

    // --- DISCONNECT ---
    
    socket.on('disconnect', () => {
        console.log(User disconnected: ${socket.id});
        const roomId = socket.data.roomId;
        
        if (roomId && rooms[roomId]) {
            // Remove user from the room list
            rooms[roomId].users = rooms[roomId].users.filter(user => user.id !== socket.id);

            // Broadcast user left
            socket.to(roomId).emit('userLeft', socket.id);
            // Update user list
            io.to(roomId).emit('updateUserList', rooms[roomId].users);

            // If room is empty, delete it
            if (rooms[roomId].users.length === 0) {
                delete rooms[roomId];
                console.log(Room deleted: ${roomId});
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(Server running on http://localhost:${PORT});
});