const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

const users = new Map();

io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on("join", (username) => {
    // Check if room is full
    if (users.size >= 6) {
      socket.emit("room-full", "Maximum 6 users allowed. Meeting is full.");
      socket.disconnect(); // Disconnect the socket
      return;
    }

    console.log(`User joined: ${username} (${socket.id})`);
    users.set(socket.id, { username, socket });

    // Notify others about the new user
    socket.broadcast.emit("new-user", {
      id: socket.id,
      username,
      existingUsers: Array.from(users.keys()),
    });

    // Send complete user list to the new joiner
    const userList = Array.from(users.entries()).map(([id, data]) => ({
      id,
      username: data.username,
    }));
    socket.emit("existing-users", userList);
  });

  socket.on("offer", (data) => {
    console.log(`Offer from ${data.sender} to ${data.target}`);
    socket.to(data.target).emit("offer", data);
  });

  socket.on("answer", (data) => {
    console.log(`Answer from ${data.sender} to ${data.target}`);
    socket.to(data.target).emit("answer", data);
  });

  socket.on("ice-candidate", (data) => {
    console.log(`ICE candidate from ${data.sender} to ${data.target}`);
    socket.to(data.target).emit("ice-candidate", data);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    users.delete(socket.id);
    socket.broadcast.emit("user-left", socket.id);
  });
});

http.listen(3000, () => console.log("Server running on http://localhost:3000"));
