// client.js
const socket = io();

// --- DOM ELEMENTS ---
const landingPage = document.getElementById('landing-page');
const roomPage = document.getElementById('room-page');
const usernameInput = document.getElementById('username-input');
const roomIdInput = document.getElementById('room-id-input');
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const errorMessage = document.getElementById('error-message');
const leaveRoomBtn = document.getElementById('leave-room-btn');

const sharedVideoPlayer = document.getElementById('shared-video-player');
const videoInputPanel = document.getElementById('video-input-panel');
const videoUrlInput = document.getElementById('video-url-input');
const loadVideoBtn = document.getElementById('load-video-btn');
const videoOverlay = document.getElementById('video-overlay');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const userListElement = document.getElementById('user-list');
const userCountElement = document.getElementById('user-count');
const roomIdDisplay = document.getElementById('room-id-display');
const currentUsernameDisplay = document.getElementById('current-username');
const voiceStatusElement = document.getElementById('voice-status');

// --- APP STATE ---
let currentUsername = '';
let currentRoomId = '';
let isHost = false; // Flag to determine who can initiate video sync changes

// --- WebRTC VARIABLES ---
const PEER_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' } // Google's free STUN server
    ]
};
const peerConnections = {}; // Stores RTCPeerConnection objects: { peerId: RTCPeerConnection }
let localStream = null;

// --- UTILITY FUNCTIONS ---

function showRoomPage(roomId, username) {
    landingPage.classList.add('hidden');
    roomPage.classList.remove('hidden');
    currentRoomId = roomId;
    currentUsername = username;
    roomIdDisplay.textContent = Room ID: ${roomId};
    currentUsernameDisplay.textContent = User: ${username};
}

function handleRoomCreationOrJoin(response) {
    if (response.success) {
        showRoomPage(response.roomId, currentUsername);
        
        // Host check: only the first creator is initially host, but all users can load video
        isHost = (socket.id === response.roomState.host);

        // Load initial video state
        if (response.roomState.videoUrl) {
            loadVideo(response.roomState.videoUrl, response.roomState.videoTime);
            if (response.roomState.videoState === 'playing') {
                // Joining user should try to sync their playback state
                sharedVideoPlayer.play().catch(e => console.error("Auto-play blocked:", e));
            }
        }
        
        // Initialize WebRTC
        initializeWebRTC();

        // Update user list initially
        updateUserList(response.users);

    } else {
        errorMessage.textContent = response.message;
    }
}

function addChatMessage(message) {
    const msgElement = document.createElement('div');
    msgElement.classList.add('chat-message');
    msgElement.innerHTML = 
        <span class="chat-time">${message.timestamp}</span> 
        <span class="chat-username" style="color:${stringToColor(message.username)}">${message.username}:</span> 
        <span class="chat-text">${message.text}</span>
    ;
    chatMessages.appendChild(msgElement);
    chatMessages.scrollTop = chatMessages.scrollHeight; // Auto-scroll to bottom
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).slice(-2);
    }
    return color;
}
function updateUserList(users) {
    userListElement.innerHTML = '';
    users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user.username + (user.id === socket.id ? ' (You)' : '');
        userListElement.appendChild(li);

        // Initiate WebRTC connection with new peer if we don't have one
        if (user.id !== socket.id && !peerConnections[user.id]) {
            createPeerConnection(user.id, true); // true for 'isInitiator'
        }
    });
    userCountElement.textContent = users.length;
}

function loadVideo(url, time) {
    // Only support direct MP4 URL for simplicity and universal sync
    if (url.endsWith('.mp4') || url.includes('blob:')) {
        sharedVideoPlayer.src = url;
        sharedVideoPlayer.currentTime = time || 0;
        videoInputPanel.classList.add('hidden');
        videoOverlay.classList.add('hidden');
        sharedVideoPlayer.classList.remove('hidden');
    } else {
        // Fallback for non-MP4: show the URL but rely on the user to open it manually (or integrate a complex player like video.js/plyr)
        sharedVideoPlayer.classList.add('hidden');
        videoOverlay.classList.remove('hidden');
        videoOverlay.innerHTML = <p>Video URL loaded: <strong>${url}</strong></p><p>Please open it in a separate tab while we use this video player for sync.</p>;
        console.warn("Non-MP4 URL detected. Sync functionality may be limited without a full video library.");
    }
}


// --- LANDING PAGE EVENT LISTENERS ---

createRoomBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    if (username) {
        errorMessage.textContent = '';
        socket.emit('createRoom', username, handleRoomCreationOrJoin);
    } else {
        errorMessage.textContent = 'Please enter a username.';
    }
});

joinRoomBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const roomId = roomIdInput.value.trim();
    if (username && roomId) {
        errorMessage.textContent = '';
        socket.emit('joinRoom', roomId, username, handleRoomCreationOrJoin);
    } else {
        errorMessage.textContent = 'Please enter both a username and a Room ID.';
    }
});

leaveRoomBtn.addEventListener('click', () => {
    if (socket.connected) {
        // Disconnect from the room on the server side
        socket.emit('disconnect'); 
    }
    // Clean up local state
    window.location.reload(); // Simplest way to reset the client state
});


// --- ROOM PAGE EVENT LISTENERS (CHAT & VIDEO) ---

// Send chat message
sendChatBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (text) {
        socket.emit('chatMessage', text);
        chatInput.value = '';
    }
});
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendChatBtn.click();
    }
});

// Load video URL
loadVideoBtn.addEventListener('click', () => {
    const url = videoUrlInput.value.trim();
    if (url) {
        // Set the video locally first, then broadcast
        loadVideo(url, 0);
        socket.emit('loadVideo', url, 0);
    }
});

// Video sync event handlers
// Use 'isHost' to prevent broadcast loops and allow only one client to be the sync source at a time
sharedVideoPlayer.addEventListener('play', () => {
    // Only the 'host' (the user who last sent a play/pause/seek event) should broadcast
    socket.emit('videoAction', 'play', sharedVideoPlayer.currentTime);
});

sharedVideoPlayer.addEventListener('pause', () => {
    socket.emit('videoAction', 'pause', sharedVideoPlayer.currentTime);
});

sharedVideoPlayer.addEventListener('seeked', () => {
    // Seeked is fired after the user has finished seeking
    socket.emit('videoAction', 'seek', sharedVideoPlayer.currentTime);
});


// --- SOCKET.IO LISTENERS (SERVER TO CLIENT) ---

// Receive new chat message
socket.on('newChatMessage', addChatMessage);
// Receive video loaded event
socket.on('videoLoaded', ({ url, time, state }) => {
    loadVideo(url, time);
    // After loading, apply the state (play/pause)
    if (state === 'playing') {
        sharedVideoPlayer.play().catch(e => console.error("Auto-play blocked:", e));
    } else {
        sharedVideoPlayer.pause();
    }
});

// Receive video action sync event
socket.on('videoEvent', ({ action, currentTime }) => {
    // Temporarily remove controls/event listeners to prevent loop
    //sharedVideoPlayer.controls = false; 

    if (action === 'play') {
        // Attempt to sync time before playing
        const diff = Math.abs(sharedVideoPlayer.currentTime - currentTime);
        if (diff > 0.5) { // If time difference is greater than 0.5 seconds, seek
            sharedVideoPlayer.currentTime = currentTime;
        }
        sharedVideoPlayer.play().catch(e => console.error("Auto-play blocked:", e));
    } else if (action === 'pause') {
        sharedVideoPlayer.pause();
        // Sync time precisely on pause
        sharedVideoPlayer.currentTime = currentTime;
    } else if (action === 'seek') {
        sharedVideoPlayer.currentTime = currentTime;
    }
    
    //sharedVideoPlayer.controls = true; // Restore controls
});

// User list updates
socket.on('userJoined', (user) => {
    console.log(${user.username} has joined.);
    addChatMessage({ username: 'System', text: ${user.username} has joined the room., timestamp: new Date().toLocaleTimeString() });
});

socket.on('userLeft', (userId) => {
    console.log(User ${userId} has left.);
    // The server will send a complete updateUserList event after this, so we just log the leave.
    addChatMessage({ username: 'System', text: A user has left the room., timestamp: new Date().toLocaleTimeString() });
    
    // Close WebRTC connection if it exists
    if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
    }
});

socket.on('updateUserList', (users) => {
    updateUserList(users);
});


// --- WebRTC FUNCTIONS & LISTENERS ---

// 1. Get local media stream (microphone)
async function initializeWebRTC() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        voiceStatusElement.textContent = 'Voice Chat: Ready (Microphone ON)';
        voiceStatusElement.style.color = 'green';
    } catch (err) {
        voiceStatusElement.textContent = 'Voice Chat: Microphone access denied.';
        voiceStatusElement.style.color = 'red';
        console.error('Error accessing microphone:', err);
    }
}

// 2. Create RTCPeerConnection and handle events
function createPeerConnection(peerId, isInitiator) {
    const pc = new RTCPeerConnection(PEER_CONFIG);
    peerConnections[peerId] = pc;
    
    // Add local audio track
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Handle incoming remote audio stream
    pc.ontrack = (event) => {
        const remoteAudio = document.createElement('audio');
        remoteAudio.autoplay = true;
        remoteAudio.controls = false;
        // Mute by default so users have to un-mute their friends
        remoteAudio.muted = false; 
        
        // Find the correct remote user indicator to link the audio to
        const userLi = Array.from(userListElement.children).find(li => li.textContent.includes(peerId));
        if (userLi) {
            userLi.appendChild(remoteAudio);
        }

        event.streams[0].getTracks().forEach(track => {
            remoteAudio.srcObject = event.streams[0];
        });
    };

    // Handle ICE candidates (network information exchange)
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtcIceCandidate', peerId, event.candidate);
}
    };
    
    // Create offer if we are the initiator (the first one to join or the one who received the userJoined event)
    if (isInitiator) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('webrtcOffer', peerId, pc.localDescription);
            } catch (err) {
                console.error('Error creating offer:', err);
            }
        };
    }

    return pc;
}

// 3. Handle WebRTC Signaling from Server

// Receive an offer from another peer
socket.on('webrtcOffer', async (peerId, offer) => {
    const pc = createPeerConnection(peerId, false); // Not the initiator

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtcAnswer', peerId, pc.localDescription);
});

// Receive an answer to our offer
socket.on('webrtcAnswer', async (peerId, answer) => {
    const pc = peerConnections[peerId];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

// Receive a new ICE candidate
socket.on('webrtcIceCandidate', async (peerId, candidate) => {
    const pc = peerConnections[peerId];
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding received ice candidate:', e);
        }
    }
});

// Add a final listener to initialize WebRTC when the user is ready (e.g., clicks the join button)
// The actual initialization is now inside handleRoomCreationOrJoin
// You could also call initializeWebRTC() immediately, but waiting for user action is better practice for media access.