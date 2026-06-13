require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const USERNAME_RE = /^[a-z0-9._]{3,20}$/;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAccountId(value) {
  const accountId = Number(value);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    const error = new Error("A valid accountId is required.");
    error.status = 400;
    throw error;
  }
  return accountId;
}

function validateUsername(username) {
  const clean = String(username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(clean)) {
    const error = new Error("Username must be 3-20 lowercase letters, numbers, dots, or underscores.");
    error.status = 400;
    throw error;
  }
  return clean;
}

function validatePassword(password) {
  if (String(password || "").length < 4) {
    const error = new Error("Password must be at least 4 characters.");
    error.status = 400;
    throw error;
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/accounts", asyncRoute(async (req, res) => {
  const username = validateUsername(req.body.username);
  validatePassword(req.body.password);
  const account = await db.createAccount({
    displayName: req.body.displayName || username,
    username,
    password: req.body.password,
    bio: req.body.bio || ""
  });
  res.status(201).json(account);
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const username = validateUsername(req.body.username);
  validatePassword(req.body.password);
  const account = await db.loginAccount({ username, password: req.body.password });
  if (!account) return res.status(401).json({ error: "Invalid username or password." });
  return res.json(account);
}));

app.get("/api/profile", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.query.accountId);
  const profile = await db.getProfile({ accountId });
  if (!profile) return res.status(404).json({ error: "Account not found." });
  return res.json(profile);
}));

app.patch("/api/profile", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.body.accountId);
  const displayName = String(req.body.displayName || "").trim();
  if (!displayName) return res.status(400).json({ error: "displayName is required." });
  const account = await db.updateAccount({ accountId, displayName, bio: req.body.bio || "" });
  if (!account) return res.status(404).json({ error: "Account not found." });
  return res.json(account);
}));

app.get("/api/accounts/search", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.query.accountId);
  const accounts = await db.searchAccounts({ accountId, q: req.query.q || "" });
  res.json(accounts);
}));

app.get("/api/friend-requests", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.query.accountId);
  res.json(await db.getFriendRequests({ accountId }));
}));

app.post("/api/friend-requests", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.body.accountId);
  const receiverUsername = validateUsername(req.body.receiverUsername);
  res.status(201).json(await db.sendFriendRequest({ accountId, receiverUsername }));
}));

app.post("/api/friend-requests/:username/accept", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.body.accountId);
  const username = validateUsername(req.params.username);
  res.json(await db.acceptFriendRequest({ accountId, username }));
}));

app.get("/api/inbox", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.query.accountId);
  res.json(await db.getInbox({ accountId }));
}));

app.get("/api/messages/:username", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.query.accountId);
  const username = validateUsername(req.params.username);
  res.json(await db.getConversation({ accountId, username }));
}));

app.post("/api/messages", asyncRoute(async (req, res) => {
  const accountId = requireAccountId(req.body.accountId);
  const receiverUsername = validateUsername(req.body.receiverUsername);
  const content = String(req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Message content is required." });
  if (content.length > 2000) return res.status(400).json({ error: "Message is too long." });
  return res.status(201).json(await db.saveDirectMessage({ accountId, receiverUsername, content }));
}));

app.use((error, req, res, next) => {
  if (error && error.code === "23505") {
    return res.status(409).json({ error: "That username or request already exists." });
  }
  if (error && error.code === "SQLITE_CONSTRAINT") {
    return res.status(409).json({ error: "That username or request already exists." });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message || "Server error." });
});

db.initializeDatabase()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`WhatsChat listening at http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
