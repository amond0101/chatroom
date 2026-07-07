require("dotenv").config();

const path = require("path");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables"
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/messages", async (req, res) => {
  const { data, error } = await supabase
    .from("messages")
    .select("username, content, created_at")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

io.on("connection", (socket) => {
  let username = "Anonymous";

  socket.on("join", (name) => {
    username = (name || username).trim().slice(0, 30) || "Anonymous";
    socket.broadcast.emit("system message", `${username}님이 입장했습니다`);
  });

  socket.on("chat message", async (content) => {
    const trimmed = (content || "").trim().slice(0, 500);
    if (!trimmed) return;

    const { error } = await supabase
      .from("messages")
      .insert({ username, content: trimmed });

    if (error) {
      console.error("Failed to save message:", error.message);
      return;
    }

    io.emit("chat message", {
      username,
      content: trimmed,
      created_at: new Date().toISOString(),
    });
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("system message", `${username}님이 퇴장했습니다`);
  });
});

server.listen(PORT, () => {
  console.log(`Chatroom server listening on http://localhost:${PORT}`);
});
