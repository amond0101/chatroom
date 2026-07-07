require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
const cookie = require("cookie");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables"
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Auth-only client (no user context needed for signUp/signInWithPassword/getUser)
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Per-user client so RLS sees role=authenticated and auth.uid() = the user's id
function dbFor(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const ACCESS_COOKIE = "sb-access-token";
const REFRESH_COOKIE = "sb-refresh-token";

function setSessionCookies(req, res, session) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const base = { httpOnly: true, sameSite: "lax", secure: isHttps, path: "/" };
  res.cookie(ACCESS_COOKIE, session.access_token, {
    ...base,
    maxAge: session.expires_in * 1000,
  });
  res.cookie(REFRESH_COOKIE, session.refresh_token, {
    ...base,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

function toUserInfo(user, accessToken) {
  return {
    id: user.id,
    email: user.email,
    username: user.user_metadata?.username || "Anonymous",
    accessToken,
  };
}

async function resolveSession(req, res) {
  const accessToken = req.cookies[ACCESS_COOKIE];
  const refreshToken = req.cookies[REFRESH_COOKIE];

  if (accessToken) {
    const { data, error } = await authClient.auth.getUser(accessToken);
    if (!error && data.user) return toUserInfo(data.user, accessToken);
  }

  if (refreshToken) {
    const { data, error } = await authClient.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (!error && data.session) {
      setSessionCookies(req, res, data.session);
      return toUserInfo(data.user, data.session.access_token);
    }
  }

  return null;
}

async function requireAuth(req, res, next) {
  const user = await resolveSession(req, res);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use((req, res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || "");
  next();
});

// ---- Auth API ----

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post("/api/auth/signup", async (req, res) => {
  const { username, email, password, passwordConfirm } = req.body || {};

  if (!username || !username.trim()) {
    return res.status(400).json({ error: "닉네임을 입력해주세요." });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "올바른 이메일을 입력해주세요." });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "비밀번호는 6자 이상이어야 합니다." });
  }
  if (password !== passwordConfirm) {
    return res.status(400).json({ error: "비밀번호가 일치하지 않습니다." });
  }

  const { data, error } = await authClient.auth.signUp({
    email,
    password,
    options: { data: { username: username.trim().slice(0, 30) } },
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  if (data.user && !data.session) {
    return res.json({
      message: "가입 확인 메일을 보냈습니다. 이메일을 확인한 뒤 로그인해주세요.",
    });
  }

  res.json({ message: "가입이 완료됐습니다." });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "이메일과 비밀번호를 입력해주세요." });
  }

  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const msg = /confirm/i.test(error.message)
      ? "이메일 인증이 필요합니다. 받은 편지함을 확인해주세요."
      : "이메일 또는 비밀번호가 올바르지 않습니다.";
    return res.status(401).json({ error: msg });
  }

  setSessionCookies(req, res, data.session);
  res.json(toUserInfo(data.user, data.session.access_token));
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookies(res);
  res.json({ message: "로그아웃 되었습니다." });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await resolveSession(req, res);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ id: user.id, email: user.email, username: user.username });
});

// ---- REST API (all require auth) ----

app.get("/api/rooms", requireAuth, async (req, res) => {
  const db = dbFor(req.user.accessToken);
  const { data, error } = await db
    .from("rooms")
    .select("id, name, created_at")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/rooms", requireAuth, async (req, res) => {
  const name = (req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Room name required" });

  const db = dbFor(req.user.accessToken);
  const { data, error } = await db
    .from("rooms")
    .insert({ name })
    .select("id, name, created_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/messages", requireAuth, async (req, res) => {
  const roomId = req.query.room_id;
  if (!roomId) return res.status(400).json({ error: "room_id required" });

  const db = dbFor(req.user.accessToken);
  const { data, error } = await db
    .from("messages")
    .select("id, username, content, image_url, created_at, reactions(emoji, username)")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const db = dbFor(req.user.accessToken);
  const key = `${Date.now()}-${crypto.randomUUID()}-${req.file.originalname}`;

  const { error } = await db.storage
    .from("attachments")
    .upload(key, req.file.buffer, { contentType: req.file.mimetype });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = db.storage.from("attachments").getPublicUrl(key);
  res.json({ url: data.publicUrl, mimeType: req.file.mimetype });
});

// ---- Socket.IO ----

io.use(async (socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || "");
  const accessToken = cookies[ACCESS_COOKIE];
  if (!accessToken) return next(new Error("unauthorized"));

  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data.user) return next(new Error("unauthorized"));

  socket.data.user = toUserInfo(data.user, accessToken);
  next();
});

// roomId -> Map<socketId, username>
const presence = new Map();

function roomPresenceList(roomId) {
  const members = presence.get(roomId);
  if (!members) return [];
  return [...members.values()];
}

function broadcastPresence(roomId) {
  io.to(roomId).emit("presence", roomPresenceList(roomId));
}

io.on("connection", (socket) => {
  const { username } = socket.data.user;
  const db = dbFor(socket.data.user.accessToken);
  let currentRoom = null;

  socket.on("join room", ({ roomId }) => {
    if (!roomId) return;

    if (currentRoom) {
      socket.leave(currentRoom);
      presence.get(currentRoom)?.delete(socket.id);
      socket.broadcast
        .to(currentRoom)
        .emit("system message", `${username}님이 퇴장했습니다`);
      broadcastPresence(currentRoom);
    }

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

    const { data, error } = await db
      .from("messages")
      .insert({
        username,
        content: trimmed || null,
        image_url: imageUrl || null,
        room_id: currentRoom,
        user_id: socket.data.user.id,
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

    const { data: existing } = await db
      .from("reactions")
      .select("id")
      .eq("message_id", messageId)
      .eq("user_id", socket.data.user.id)
      .eq("emoji", emoji)
      .maybeSingle();

    if (existing) {
      await db.from("reactions").delete().eq("id", existing.id);
    } else {
      await db
        .from("reactions")
        .insert({ message_id: messageId, username, emoji, user_id: socket.data.user.id });
    }

    const { data: reactions, error } = await db
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
