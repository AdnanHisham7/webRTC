const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

const users = new Map();

io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Change the existing-users emission logic
  socket.on("join", (username) => {
    console.log(`User joined: ${username} (${socket.id})`);
    users.set(socket.id, { username, socket });

    // Notify others and send existing users WITH USERNAMES
    socket.broadcast.emit("new-user", {
      id: socket.id,
      username,
      existingUsers: Array.from(users.keys()), // Send all connected IDs
    });

    // Send complete user list to new joiner
    const userList = Array.from(users.entries()).map(([id, data]) => ({
      id,
      username: data.username,
    }));
    socket.emit("existing-users", userList);
  });

  // Enhanced logging for signaling
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
});

http.listen(3000, () => console.log("Server running on http://localhost:3000"));
