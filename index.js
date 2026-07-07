require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---- REST API ----

app.get("/api/rooms", async (req, res) => {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, name, created_at")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/rooms", async (req, res) => {
  const name = (req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Room name required" });

  const { data, error } = await supabase
    .from("rooms")
    .insert({ name })
    .select("id, name, created_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/messages", async (req, res) => {
  const roomId = req.query.room_id;
  if (!roomId) return res.status(400).json({ error: "room_id required" });

  const { data, error } = await supabase
    .from("messages")
    .select("id, username, content, image_url, created_at, reactions(emoji, username)")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const key = `${Date.now()}-${crypto.randomUUID()}-${req.file.originalname}`;

  const { error } = await supabase.storage
    .from("attachments")
    .upload(key, req.file.buffer, { contentType: req.file.mimetype });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = supabase.storage.from("attachments").getPublicUrl(key);
  res.json({ url: data.publicUrl, mimeType: req.file.mimetype });
});

// ---- Socket.IO ----

// roomId -> Map<socketId, username>
const presence = new Map();

function roomPresenceList(roomId) {
  const members = presence.get(roomId);
  if (!members) return [];
  return [...new Set(members.values())];
}

function broadcastPresence(roomId) {
  io.to(roomId).emit("presence", roomPresenceList(roomId));
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let username = "Anonymous";

  socket.on("join room", ({ roomId, username: name }) => {
    if (!roomId) return;

    if (currentRoom) {
      socket.leave(currentRoom);
      presence.get(currentRoom)?.delete(socket.id);
      socket.broadcast
        .to(currentRoom)
        .emit("system message", `${username}님이 퇴장했습니다`);
      broadcastPresence(currentRoom);
    }

    username = (name || username).trim().slice(0, 30) || "Anonymous";
    currentRoom = roomId;
    socket.join(roomId);

    if (!presence.has(roomId)) presence.set(roomId, new Map());
    presence.get(roomId).set(socket.id, username);

    socket.broadcast
      .to(roomId)
      .emit("system message", `${username}님이 입장했습니다`);
    broadcastPresence(roomId);
  });

  socket.on("typing", () => {
    if (!currentRoom) return;
    socket.broadcast.to(currentRoom).emit("typing", { username });
  });

  socket.on("stop typing", () => {
    if (!currentRoom) return;
    socket.broadcast.to(currentRoom).emit("stop typing", { username });
  });

  socket.on("chat message", async ({ content, imageUrl }) => {
    if (!currentRoom) return;
    const trimmed = (content || "").trim().slice(0, 500);
    if (!trimmed && !imageUrl) return;

    const { data, error } = await supabase
      .from("messages")
      .insert({
        username,
        content: trimmed || null,
        image_url: imageUrl || null,
        room_id: currentRoom,
      })
      .select("id, username, content, image_url, created_at")
      .single();

    if (error) {
      console.error("Failed to save message:", error.message);
      return;
    }

    io.to(currentRoom).emit("chat message", { ...data, reactions: [] });
  });

  socket.on("reaction", async ({ messageId, emoji }) => {
    if (!currentRoom || !messageId || !emoji) return;

    const { data: existing } = await supabase
      .from("reactions")
      .select("id")
      .eq("message_id", messageId)
      .eq("username", username)
      .eq("emoji", emoji)
      .maybeSingle();

    if (existing) {
      await supabase.from("reactions").delete().eq("id", existing.id);
    } else {
      await supabase
        .from("reactions")
        .insert({ message_id: messageId, username, emoji });
    }

    const { data: reactions, error } = await supabase
      .from("reactions")
      .select("emoji, username")
      .eq("message_id", messageId);

    if (error) {
      console.error("Failed to load reactions:", error.message);
      return;
    }

    io.to(currentRoom).emit("reactions update", { messageId, reactions });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    presence.get(currentRoom)?.delete(socket.id);
    socket.broadcast
      .to(currentRoom)
      .emit("system message", `${username}님이 퇴장했습니다`);
    broadcastPresence(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Chatroom server listening on http://localhost:${PORT}`);
});
