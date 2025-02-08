const socket = io();
const username = new URLSearchParams(window.location.search).get("username");
let localStream;
const peers = new Map();

// Debugging element
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
  window.addEventListener("beforeunload", endCall);
  window.addEventListener("pagehide", endCall);
}

async function startMedia() {
  try {
    document.getElementById("permissionModal").classList.add("hidden");

    // Use basic constraints
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
  socket.on("room-full", (message) => {
    showError("Meeting Full", message);
    endCall();
    setTimeout(() => {
      window.location.href = "/";
    }, 3000);
  });
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

async function handleExistingUsers(userList) {
  logDebug(`Existing users: ${userList.length}`);
  for (const user of userList) {
    if (user.id !== socket.id) {
      // Store the username and a placeholder for the peer connection
      peers.set(user.id, { peer: null, username: user.username });
      await createPeerConnection(user.id);
    }
  }
}

async function handleNewUser({ id: userId, username }) {
  logDebug(`New user joined: ${username} (${userId})`);
  // Only add if not already present
  if (!peers.has(userId)) {
    peers.set(userId, { peer: null, username });
  }
  await createPeerConnection(userId);
  updateParticipantsList();
}

async function createPeerConnection(userId) {
  // Only create a new connection if one hasn't been established yet
  if (peers.get(userId)?.peer) {
    logDebug(`Peer connection already exists for ${userId}`);
    return peers.get(userId).peer;
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
  const storedData = peers.get(userId) || {};
  const remoteUsername = storedData.username || "Remote User";
  peers.set(userId, { peer, username: remoteUsername });

  // Add local tracks
  localStream.getTracks().forEach((track) => {
    peer.addTrack(track, localStream);
  });

  // Handle remote media
  peer.ontrack = (event) => {
    const stream = event.streams[0];
    updateVideoElement(userId, stream);
    updatePeerUsername(userId, remoteUsername);
  };

  // ICE candidate handling
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

  peer.onicecandidateerror = (error) => {
    logDebug(`ICE Candidate Error: ${error.errorCode} ${error.errorText}`);
  };

  peer.onconnectionstatechange = () => {
    logDebug(`Connection state (${userId}): ${peer.connectionState}`);
    if (peer.connectionState === "connected") {
      updatePeerUsername(userId, remoteUsername);
    }
  };

  // Only one side should initiate the offer.
  // Here we use a simple deterministic check based on the socket IDs.
  if (socket.id < userId) {
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
  const entry = peers.get(userId);
  if (entry && entry.peer) {
    entry.peer.close();
  }
  peers.delete(userId);
  const videoElement = document.getElementById(`video-${userId}`);
  if (videoElement) videoElement.remove();
  updateParticipantsList();
}

function updateVideoElement(userId, stream) {
  let videoElement = document.getElementById(`video-${userId}`);
  if (!videoElement) {
    videoElement = document.createElement("div");
    videoElement.id = `video-${userId}`;
    videoElement.className =
      "bg-black rounded-lg overflow-hidden border border-green-600 shadow-lg relative aspect-video w-full max-w-[600px] flex justify-center items-center";

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

    // Setup mute/unmute listeners for tracks (if available)
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (videoTrack) {
      videoTrack.onmute = () =>
        document
          .getElementById(`remote-video-icon-${userId}`)
          ?.classList.remove("hidden");
      videoTrack.onunmute = () =>
        document
          .getElementById(`remote-video-icon-${userId}`)
          ?.classList.add("hidden");
    }

    if (audioTrack) {
      audioTrack.onmute = () =>
        document
          .getElementById(`remote-audio-icon-${userId}`)
          ?.classList.remove("hidden");
      audioTrack.onunmute = () =>
        document
          .getElementById(`remote-audio-icon-${userId}`)
          ?.classList.add("hidden");
    }
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
      if (videoTrack.enabled) {
        document.getElementById("local-video-icon").classList.add("hidden");
        document
          .getElementById("toggleVideo")
          .classList.replace("bg-gray-800", "bg-[#0E3A3A]");
        document
          .getElementById("video-icon")
          .classList.replace("fa-video-slash", "fa-video");
      } else {
        document.getElementById("local-video-icon").classList.remove("hidden");
        document
          .getElementById("toggleVideo")
          .classList.replace("bg-[#0E3A3A]", "bg-gray-800");
        document
          .getElementById("video-icon")
          .classList.replace("fa-video", "fa-video-slash");
      }
      logDebug(`Video ${videoTrack.enabled ? "enabled" : "disabled"}`);
    }
  });

  document.getElementById("toggleAudio").addEventListener("click", () => {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      if (audioTrack.enabled) {
        document.getElementById("local-audio-icon").classList.add("hidden");
        document
          .getElementById("toggleAudio")
          .classList.replace("bg-gray-800", "bg-[#0E3A3A]");
        document
          .getElementById("audio-icon")
          .classList.replace("fa-microphone-slash", "fa-microphone");
      } else {
        document.getElementById("local-audio-icon").classList.remove("hidden");
        document
          .getElementById("toggleAudio")
          .classList.replace("bg-[#0E3A3A]", "bg-gray-800");
        document
          .getElementById("audio-icon")
          .classList.replace("fa-microphone", "fa-microphone-slash");
      }
      logDebug(`Audio ${audioTrack.enabled ? "enabled" : "disabled"}`);
    }
  });

  document.getElementById("endCall").addEventListener("click", endCall);
}

// Toggle offcanvas when "Participants" button is clicked
document.getElementById("toggleParticipants").addEventListener("click", () => {
  const offcanvas = document.getElementById("participantsOffcanvas");
  offcanvas.classList.toggle("translate-x-full");
  updateParticipantsList(); // Refresh the list each time the panel is opened
});

// Close button inside the offcanvas
document.getElementById("closeParticipants").addEventListener("click", () => {
  document
    .getElementById("participantsOffcanvas")
    .classList.add("translate-x-full");
});

function updateParticipantsList() {
  const list = document.getElementById("participantsList");
  list.innerHTML = ""; // Clear the list before updating

  // Add local user
  const localItem = document.createElement("li");
  localItem.textContent = username + " (You)";
  localItem.classList.add("border-b", "border-gray-800", "pb-1");
  list.appendChild(localItem);

  // Add remote users from peers (each peer entry contains the remote username)
  peers.forEach(({ username: remoteUsername }, id) => {
    const item = document.createElement("li");
    item.textContent = remoteUsername;
    item.classList.add("border-b", "border-gray-800", "pb-1");
    list.appendChild(item);
  });
}

function endCall() {
  logDebug("Ending call...");

  // Stop local media
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    document.getElementById("localVideo").srcObject = null;
    localStream = null;
  }

  // Close all peer connections
  peers.forEach(({ peer }) => {
    if (peer) peer.close();
  });
  peers.clear();

  // Disconnect from the signaling server
  socket.disconnect();

  // Redirect to home (adjust as needed)
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
