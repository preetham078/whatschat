const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");

const POSTGRES_URL =
  process.env.SUPABASE_DB_URL ||
  process.env.SUPABASE_DATABASE_URL ||
  process.env.DATABASE_URL;

let pool = null;
let sqliteDb = null;
let sqliteCli = false;
let sqliteFile = path.join(__dirname, "data.sqlite");
const isPostgres = Boolean(POSTGRES_URL);

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    bio: row.bio || "",
    createdAt: row.created_at
  };
}

function normalizeRows(result) {
  return Array.isArray(result) ? result : result.rows;
}

function placeholders(count, offset = 1) {
  if (!isPostgres) return Array(count).fill("?").join(", ");
  return Array.from({ length: count }, (_, index) => `$${index + offset}`).join(", ");
}

function adaptSql(sql, params = []) {
  if (isPostgres) return { sql, params };
  const nextParams = [];
  let index = 0;
  const adaptedSql = sql
    .replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
    .replace(/TIMESTAMPTZ/g, "TEXT")
    .replace(/\$(\d+)/g, (match, position) => {
      index += 1;
      nextParams.push(params[Number(position) - 1]);
      return "?";
    });
  return { sql: adaptedSql, params: index ? nextParams : params };
}

async function query(sql, params = []) {
  if (isPostgres) {
    return pool.query(sql, params);
  }

  const adaptedQuery = adaptSql(sql, params);
  const adapted = adaptedQuery.sql;
  const verb = adapted.trim().split(/\s+/)[0].toUpperCase();

  if (sqliteCli) {
    return querySqliteCli(adapted, adaptedQuery.params, verb);
  }

  if (verb === "SELECT" || adapted.includes("RETURNING")) {
    return new Promise((resolve, reject) => {
      sqliteDb.all(adapted, adaptedQuery.params, (error, rows) => {
        if (error) reject(error);
        else resolve({ rows });
      });
    });
  }

  return new Promise((resolve, reject) => {
    sqliteDb.run(adapted, adaptedQuery.params, function onRun(error) {
      if (error) reject(error);
      else resolve({ rows: [], lastID: this.lastID, changes: this.changes });
    });
  });
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function materializeSql(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => sqlLiteral(params[index++]));
}

function parseSqliteJson(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  return JSON.parse(text);
}

function querySqliteCli(sql, params, verb) {
  const materialized = materializeSql(sql, params);
  if (verb === "SELECT" || materialized.includes("RETURNING")) {
    const output = execFileSync("sqlite3", [sqliteFile, "-json", materialized], { encoding: "utf8" });
    return { rows: parseSqliteJson(output) };
  }

  const output = execFileSync(
    "sqlite3",
    [sqliteFile, "-json", `${materialized}; SELECT last_insert_rowid() AS lastID, changes() AS changes;`],
    { encoding: "utf8" }
  );
  const meta = parseSqliteJson(output)[0] || {};
  return { rows: [], lastID: meta.lastID, changes: meta.changes || 0 };
}

async function runInsert(sql, params = []) {
  if (isPostgres) {
    const result = await query(sql, params);
    return result.rows[0];
  }

  const result = await query(sql.replace(/\s+RETURNING\s+\*/i, ""), params);
  const id = result.lastID;
  const tableMatch = sql.match(/INSERT INTO\s+([a-z_]+)/i);
  const table = tableMatch && tableMatch[1];
  if (!table) return null;
  const inserted = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return inserted.rows[0];
}

async function initializeDatabase() {
  if (isPostgres) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: POSTGRES_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
    });
  } else {
    let sqlite3;
    try {
      sqlite3 = require("sqlite3").verbose();
    } catch (error) {
      try {
        execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
        sqliteCli = true;
      } catch {
        error.message = "sqlite3 optional dependency or sqlite3 CLI is required for local development. Run npm install.";
        throw error;
      }
    }

    if (!sqliteCli) {
      sqliteDb = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(sqliteFile, (err) => {
          if (err) reject(err);
          else resolve(db);
        });
      });
    }

    await query("PRAGMA foreign_keys = ON");
  }

  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(requester_id, receiver_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAccountById(accountId) {
  const result = await query("SELECT * FROM accounts WHERE id = $1", [accountId]);
  return publicAccount(result.rows[0]);
}

async function getRawAccountByUsername(username) {
  const result = await query("SELECT * FROM accounts WHERE username = $1", [String(username).toLowerCase()]);
  return result.rows[0];
}

async function createAccount({ displayName, username, password, bio = "" }) {
  const cleanUsername = String(username).toLowerCase().trim();
  const row = await runInsert(
    `INSERT INTO accounts (display_name, username, password_hash, bio)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(displayName || cleanUsername).trim(), cleanUsername, hashPassword(password), String(bio || "").trim()]
  );
  return publicAccount(row);
}

async function loginAccount({ username, password }) {
  const account = await getRawAccountByUsername(username);
  if (!account || account.password_hash !== hashPassword(password)) return null;
  return publicAccount(account);
}

async function updateAccount({ accountId, displayName, bio }) {
  if (isPostgres) {
    const result = await query(
      `UPDATE accounts SET display_name = $1, bio = $2 WHERE id = $3 RETURNING *`,
      [String(displayName).trim(), String(bio || "").trim(), accountId]
    );
    return publicAccount(result.rows[0]);
  }

  await query("UPDATE accounts SET display_name = $1, bio = $2 WHERE id = $3", [
    String(displayName).trim(),
    String(bio || "").trim(),
    accountId
  ]);
  return getAccountById(accountId);
}

async function friendshipStatus(accountId, otherId) {
  const result = await query(
    `SELECT * FROM friend_requests
     WHERE (requester_id = $1 AND receiver_id = $2)
        OR (requester_id = $2 AND receiver_id = $1)
     ORDER BY id DESC LIMIT 1`,
    [accountId, otherId]
  );
  const request = result.rows[0];
  if (!request) return "none";
  if (request.status === "accepted") return "friends";
  return request.requester_id === Number(accountId) ? "outgoing" : "incoming";
}

async function areFriends(accountId, otherId) {
  return (await friendshipStatus(accountId, otherId)) === "friends";
}

async function searchAccounts({ accountId, q }) {
  const term = `%${String(q || "").toLowerCase().trim()}%`;
  const result = await query(
    `SELECT * FROM accounts
     WHERE id <> $1 AND username LIKE $2
     ORDER BY username ASC LIMIT 12`,
    [accountId, term]
  );
  const rows = [];
  for (const account of result.rows) {
    rows.push({
      ...publicAccount(account),
      friendshipStatus: await friendshipStatus(accountId, account.id)
    });
  }
  return rows;
}

async function sendFriendRequest({ accountId, receiverUsername }) {
  const receiver = await getRawAccountByUsername(receiverUsername);
  if (!receiver) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }
  if (receiver.id === Number(accountId)) {
    const error = new Error("You cannot add yourself.");
    error.status = 400;
    throw error;
  }

  const existingStatus = await friendshipStatus(accountId, receiver.id);
  if (existingStatus === "friends") {
    const error = new Error("You are already friends.");
    error.status = 409;
    throw error;
  }
  if (existingStatus === "incoming" || existingStatus === "outgoing") {
    const error = new Error("A pending request already exists.");
    error.status = 409;
    throw error;
  }

  await runInsert(
    `INSERT INTO friend_requests (requester_id, receiver_id, status)
     VALUES ($1, $2, 'pending') RETURNING *`,
    [accountId, receiver.id]
  );
  return getFriendRequests({ accountId });
}

async function acceptFriendRequest({ accountId, username }) {
  const requester = await getRawAccountByUsername(username);
  if (!requester) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  const result = await query(
    `UPDATE friend_requests
     SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
     WHERE requester_id = $1 AND receiver_id = $2 AND status = 'pending'`,
    [requester.id, accountId]
  );

  if (!isPostgres && result.changes === 0) {
    const error = new Error("No incoming request found.");
    error.status = 404;
    throw error;
  }

  if (isPostgres && result.rowCount === 0) {
    const error = new Error("No incoming request found.");
    error.status = 404;
    throw error;
  }

  return getFriendRequests({ accountId });
}

async function getFriendRequests({ accountId }) {
  const incoming = await query(
    `SELECT fr.*, a.display_name, a.username, a.bio, a.created_at AS account_created_at
     FROM friend_requests fr
     JOIN accounts a ON a.id = fr.requester_id
     WHERE fr.receiver_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [accountId]
  );
  const outgoing = await query(
    `SELECT fr.*, a.display_name, a.username, a.bio, a.created_at AS account_created_at
     FROM friend_requests fr
     JOIN accounts a ON a.id = fr.receiver_id
     WHERE fr.requester_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [accountId]
  );

  const mapRequest = (row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    account: publicAccount({
      id: row.requester_id === Number(accountId) ? row.receiver_id : row.requester_id,
      display_name: row.display_name,
      username: row.username,
      bio: row.bio,
      created_at: row.account_created_at
    })
  });

  return {
    incoming: incoming.rows.map(mapRequest),
    outgoing: outgoing.rows.map(mapRequest)
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    content: row.content,
    createdAt: row.created_at
  };
}

async function getConversation({ accountId, username }) {
  const other = await getRawAccountByUsername(username);
  if (!other) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }
  if (!(await areFriends(accountId, other.id))) {
    const error = new Error("You can only message accepted friends.");
    error.status = 403;
    throw error;
  }
  const result = await query(
    `SELECT * FROM direct_messages
     WHERE (sender_id = $1 AND receiver_id = $2)
        OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at ASC, id ASC`,
    [accountId, other.id]
  );
  return {
    friend: publicAccount(other),
    messages: result.rows.map(mapMessage)
  };
}

async function saveDirectMessage({ accountId, receiverUsername, content }) {
  const other = await getRawAccountByUsername(receiverUsername);
  if (!other) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }
  if (!(await areFriends(accountId, other.id))) {
    const error = new Error("You can only message accepted friends.");
    error.status = 403;
    throw error;
  }

  await runInsert(
    `INSERT INTO direct_messages (sender_id, receiver_id, content)
     VALUES ($1, $2, $3) RETURNING *`,
    [accountId, other.id, String(content).trim()]
  );
  return getConversation({ accountId, username: receiverUsername });
}

async function getInbox({ accountId }) {
  const result = await query(
    `SELECT
       a.id,
       a.display_name,
       a.username,
       a.bio,
       a.created_at,
       dm.content AS latest_message,
       dm.created_at AS latest_at
     FROM friend_requests fr
     JOIN accounts a ON a.id = CASE WHEN fr.requester_id = $1 THEN fr.receiver_id ELSE fr.requester_id END
     LEFT JOIN direct_messages dm ON dm.id = (
       SELECT id FROM direct_messages d
       WHERE (d.sender_id = $1 AND d.receiver_id = a.id)
          OR (d.sender_id = a.id AND d.receiver_id = $1)
       ORDER BY d.created_at DESC, d.id DESC LIMIT 1
     )
     WHERE fr.status = 'accepted' AND (fr.requester_id = $1 OR fr.receiver_id = $1)
     ORDER BY COALESCE(dm.created_at, fr.updated_at) DESC, a.username ASC`,
    [accountId]
  );
  return result.rows.map((row) => ({
    friend: publicAccount(row),
    latestMessage: row.latest_message || "",
    latestAt: row.latest_at || null
  }));
}

async function getProfile({ accountId }) {
  const accountResult = await query("SELECT * FROM accounts WHERE id = $1", [accountId]);
  const account = accountResult.rows[0];
  if (!account) return null;

  const friends = await query(
    `SELECT COUNT(*) AS count FROM friend_requests
     WHERE status = 'accepted' AND (requester_id = $1 OR receiver_id = $1)`,
    [accountId]
  );
  const chats = await query(
    `SELECT COUNT(DISTINCT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END) AS count
     FROM direct_messages WHERE sender_id = $1 OR receiver_id = $1`,
    [accountId]
  );
  const messages = await query(
    "SELECT COUNT(*) AS count FROM direct_messages WHERE sender_id = $1 OR receiver_id = $1",
    [accountId]
  );

  return {
    account: publicAccount(account),
    stats: {
      friends: Number(friends.rows[0].count || 0),
      chats: Number(chats.rows[0].count || 0),
      messages: Number(messages.rows[0].count || 0)
    }
  };
}

module.exports = {
  initializeDatabase,
  createAccount,
  loginAccount,
  updateAccount,
  searchAccounts,
  saveDirectMessage,
  getConversation,
  getInbox,
  getProfile,
  getAccountById,
  sendFriendRequest,
  acceptFriendRequest,
  getFriendRequests
};
