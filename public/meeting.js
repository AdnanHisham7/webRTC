const socket = io();
const username = new URLSearchParams(window.location.search).get("username");
let localStream;
const peers = new Map();

// Debugging elements
const debugDiv = document.createElement("div");
debugDiv.style.position = "fixed";
debugDiv.style.top = "10px";
debugDiv.style.left = "10px";
debugDiv.style.color = "white";
debugDiv.style.zIndex = "1000";
debugDiv.style.backgroundColor = "rgba(0,0,0,0.7)";
debugDiv.style.padding = "10px";
debugDiv.style.borderRadius = "5px";
debugDiv.style.maxWidth = "300px";
debugDiv.style.overflow = "auto";
debugDiv.style.maxHeight = "200px";
document.body.appendChild(debugDiv);

// Set local username display
document.getElementById("localUsername").textContent = username;

async function init() {
  // Mobile-first permission handling
  if (/Mobi|Android/i.test(navigator.userAgent)) {
    document.getElementById("permissionModal").classList.remove("hidden");
    document
      .getElementById("startCallBtn")
      .addEventListener("click", startMedia);
  } else {
    await startMedia();
  }
  // Add to the init() function
  window.addEventListener("beforeunload", endCall);
  window.addEventListener("pagehide", endCall);
}

async function startMedia() {
  try {
    document.getElementById("permissionModal").classList.add("hidden");

    // Use basic constraints to avoid device enumeration issues
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: true,
    });

    document.getElementById("localVideo").srcObject = localStream;
    socket.emit("join", username);
    setupSocketIO();
    setupControls();
    logDebug("Media access successful");
  } catch (error) {
    handleMediaError(error);
  }
}

function setupSocketIO() {
  socket.on("existing-users", handleExistingUsers);
  socket.on("new-user", handleNewUser);
  socket.on("user-left", handleUserLeft);
  socket.on("offer", handleReceiveOffer);
  socket.on("answer", handleReceiveAnswer);
  socket.on("ice-candidate", handleIceCandidate);

  socket.on("connect_error", (error) => {
    logDebug(`Socket error: ${error.message}`);
    showError("Connection Error", "Failed to connect to signaling server");
  });
}

// Update handleExistingUsers to filter out self
async function handleExistingUsers(userList) {
  logDebug(`Existing users: ${userList.length}`);
  for (const user of userList) {
    if (user.id !== socket.id) {
      await createPeerConnection(user.id);
    }
  }
}

// Modify handleNewUser to check existing connections
async function handleNewUser({ id: userId, username, existingUsers }) {
  logDebug(`New user joined: ${username} (${userId})`);

  // Check if we already have a connection
  if (!peers.has(userId) && !existingUsers.includes(socket.id)) {
    await createPeerConnection(userId);
  }
}

async function createPeerConnection(userId) {
  if (peers.has(userId)) {
    logDebug(`Existing connection to ${userId}`);
    return;
  }

  logDebug(`Creating peer connection with ${userId}`);

  const configuration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
  };

  const peer = new RTCPeerConnection(configuration);
  peers.set(userId, { peer, username: "Connecting..." });

  // Add local tracks
  localStream.getTracks().forEach((track) => {
    peer.addTrack(track, localStream);
  });

  // Handle remote media
  peer.ontrack = (event) => {
    logDebug(`Received media from ${userId}`);
    const stream = event.streams[0];
    updateVideoElement(userId, stream);
  };

  // ICE Candidate handling
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) {
      logDebug(`Sending ICE candidate to ${userId}`);
      socket.emit("ice-candidate", {
        target: userId,
        candidate: candidate.toJSON(),
        sender: socket.id,
      });
    }
  };

  // Add this to peer initialization
  peer.onnegotiationneeded = async () => {
    logDebug(`Negotiation needed with ${userId}`);
    try {
      if (socket.id < userId) {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("offer", {
          target: userId,
          offer: peer.localDescription.toJSON(),
          sender: socket.id,
        });
      }
    } catch (error) {
      logDebug(`Negotiation error: ${error.message}`);
    }
  };

  peer.onicecandidateerror = (error) => {
    logDebug(`ICE Candidate Error: ${error.errorCode} ${error.errorText}`);
  };

  // Connection state handling
  peer.onconnectionstatechange = () => {
    logDebug(`Connection state (${userId}): ${peer.connectionState}`);
    if (peer.connectionState === "connected") {
      updatePeerUsername(userId, "Remote User");
    }
  };

  // Create offer if initiator
  // In createPeerConnection function, modify the offer creation condition
  if (userId !== socket.id) {
    // Add deterministic offer initiation
    if (socket.id < userId) {
      // Only lower ID initiates offer
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        logDebug(`Sending offer to ${userId}`);

        socket.emit("offer", {
          target: userId,
          offer: peer.localDescription.toJSON(),
          sender: socket.id,
        });
      } catch (error) {
        logDebug(`Offer error: ${error.message}`);
      }
    }
  }

  return peer;
}

async function handleReceiveOffer({ offer, sender }) {
  logDebug(`Received offer from ${sender}`);
  const peer = await createPeerConnection(sender);

  try {
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    socket.emit("answer", {
      target: sender,
      answer: peer.localDescription.toJSON(),
      sender: socket.id,
    });
  } catch (error) {
    logDebug(`Answer error: ${error.message}`);
  }
}

async function handleReceiveAnswer({ answer, sender }) {
  logDebug(`Received answer from ${sender}`);
  const peer = peers.get(sender)?.peer;
  if (peer) {
    try {
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      logDebug(`Answer handling error: ${error.message}`);
    }
  }
}

function handleIceCandidate({ candidate, sender }) {
  logDebug(`Received ICE candidate from ${sender}`);
  const peer = peers.get(sender)?.peer;
  if (peer && candidate) {
    peer
      .addIceCandidate(new RTCIceCandidate(candidate))
      .catch((error) => logDebug(`ICE Error: ${error.message}`));
  }
}

function handleUserLeft(userId) {
  logDebug(`User left: ${userId}`);
  const peer = peers.get(userId);
  if (peer) {
    // Close peer connection and clean up tracks
    peer.peer.getSenders().forEach((sender) => {
      if (sender.track) sender.track.stop();
    });
    peer.peer.close();
    peers.delete(userId);
  }
  const videoElement = document.getElementById(`video-${userId}`);
  if (videoElement) videoElement.remove();
}

function updateVideoElement(userId, stream) {
  let videoElement = document.getElementById(`video-${userId}`);
  if (!videoElement) {
    videoElement = document.createElement("div");
    videoElement.id = `video-${userId}`;
    videoElement.className =
      "bg-black rounded-lg overflow-hidden relative aspect-video";

    const video = document.createElement("video");
    video.autoplay = true;
    video.className = "w-full h-full object-cover";

    const nameTag = document.createElement("div");
    nameTag.className =
      "absolute bottom-2 left-2 bg-black bg-opacity-50 p-2 rounded-lg";
    nameTag.id = `name-${userId}`;

    videoElement.appendChild(video);
    videoElement.appendChild(nameTag);
    document.getElementById("videoContainer").appendChild(videoElement);
  }

  const video = videoElement.querySelector("video");
  video.srcObject = stream;
}

function updatePeerUsername(userId, username) {
  const nameTag = document.getElementById(`name-${userId}`);
  if (nameTag) {
    nameTag.innerHTML = `<span class="text-white text-sm">${username}</span>`;
  }
}

function handleMediaError(error) {
  let message = "Failed to access media devices: ";
  switch (error.name) {
    case "NotAllowedError":
      message += "Permission denied. Please allow camera/microphone access.";
      break;
    case "NotFoundError":
      message += "No media devices found.";
      break;
    case "NotReadableError":
      message +=
        "Device is already in use. Close other applications using the camera/microphone.";
      break;
    default:
      message += error.message;
  }

  showError("Media Error", message);
  logDebug(`Media Error: ${error}`);
}

function setupControls() {
  document.getElementById("toggleVideo").addEventListener("click", () => {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      logDebug(`Video ${videoTrack.enabled ? "enabled" : "disabled"}`);
    }
  });

  document.getElementById("toggleAudio").addEventListener("click", () => {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      logDebug(`Audio ${audioTrack.enabled ? "enabled" : "disabled"}`);
    }
  });

  document.getElementById("endCall").addEventListener("click", endCall);
}

function endCall() {
  logDebug("Ending call...");

  // Stop local media
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      track.stop();
    });
    document.getElementById("localVideo").srcObject = null; // Clear video element
    localStream = null;
  }

  // Close all peer connections
  peers.forEach(({ peer }) => peer.close());
  peers.clear();

  // Redirect to home
  window.location.href = "/";
}

function logDebug(message) {
  const timestamp = new Date().toLocaleTimeString();
  debugDiv.innerHTML += `<div class="text-xs">[${timestamp}] ${message}</div>`;
  debugDiv.scrollTop = debugDiv.scrollHeight;
  console.log(`[DEBUG] ${message}`);
}

function showError(title, message) {
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorModal").classList.remove("hidden");
}

// Initialize the app
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  showError(
    "Unsupported Browser",
    "WebRTC is not supported in this browser. Please use Chrome, Firefox, or Safari."
  );
} else {
  init();
}
