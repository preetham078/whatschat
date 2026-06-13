const SESSION_KEY = "pingmeAccount";
const STATIC_KEY = "pingmeStaticData";
const params = new URLSearchParams(window.location.search);
const queryApiBase = params.get("api");
const configApiBase = window.PINGME_API_BASE || "";
const isLocalPage = ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);
const configuredBase = queryApiBase || (isLocalPage ? "" : configApiBase);
const apiBase = configuredBase.replace(/\/$/, "");
const hasSharedBackend = Boolean(apiBase) || !location.hostname.includes("github.io");
const sameOrigin = !apiBase || apiBase === window.location.origin;

const state = {
  account: null,
  profile: null,
  activeView: "chats",
  activeChat: null,
  backendAvailable: hasSharedBackend,
  poll: null,
  staticData: loadStaticData()
};

const el = {
  status: document.getElementById("status"),
  authPanel: document.getElementById("authPanel"),
  profilePanel: document.getElementById("profilePanel"),
  loginForm: document.getElementById("loginForm"),
  signupForm: document.getElementById("signupForm"),
  profileForm: document.getElementById("profileForm"),
  profileName: document.getElementById("profileName"),
  profileUsername: document.getElementById("profileUsername"),
  profileBio: document.getElementById("profileBio"),
  profileAvatar: document.getElementById("profileAvatar"),
  statFriends: document.getElementById("statFriends"),
  statChats: document.getElementById("statChats"),
  statMessages: document.getElementById("statMessages"),
  inboxList: document.getElementById("inboxList"),
  emptyInbox: document.getElementById("emptyInbox"),
  incomingRequests: document.getElementById("incomingRequests"),
  outgoingRequests: document.getElementById("outgoingRequests"),
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  searchResults: document.getElementById("searchResults"),
  messagesList: document.getElementById("messagesList"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  chatPanel: document.getElementById("chatPanel"),
  chatAvatar: document.getElementById("chatAvatar"),
  chatName: document.getElementById("chatName"),
  chatUsername: document.getElementById("chatUsername"),
  sidebar: document.getElementById("sidebar"),
  topSubtitle: document.getElementById("topSubtitle")
};

function showStatus(message) {
  el.status.textContent = message;
  el.status.classList.add("show");
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => el.status.classList.remove("show"), 2800);
}

function loadStaticData() {
  const fallback = { accounts: [], friendRequests: [], messages: [], nextId: 1 };
  try {
    return JSON.parse(localStorage.getItem(STATIC_KEY)) || fallback;
  } catch {
    return fallback;
  }
}

function saveStaticData() {
  localStorage.setItem(STATIC_KEY, JSON.stringify(state.staticData));
}

function publicAccount(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    username: account.username,
    bio: account.bio || "",
    createdAt: account.createdAt
  };
}

async function request(path, options = {}) {
  if (!state.backendAvailable) return staticRequest(path, options);

  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  } catch (error) {
    if (sameOrigin || location.hostname.includes("github.io")) {
      state.backendAvailable = false;
      showStatus("Backend unavailable. Using local-only mode in this browser.");
      return staticRequest(path, options);
    }
    throw error;
  }
}

function staticRequest(path, options = {}) {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  const url = new URL(path, "https://local.app");
  const data = state.staticData;

  if (path === "/api/health") return { ok: true };

  if (path === "/api/accounts" && method === "POST") {
    const username = normalizeUsername(body.username);
    if (data.accounts.some((account) => account.username === username)) throw new Error("Username already exists.");
    const account = {
      id: data.nextId++,
      displayName: body.displayName || username,
      username,
      password: body.password,
      bio: body.bio || "",
      createdAt: new Date().toISOString()
    };
    data.accounts.push(account);
    saveStaticData();
    return publicAccount(account);
  }

  if (path === "/api/login" && method === "POST") {
    const account = data.accounts.find((item) => item.username === normalizeUsername(body.username) && item.password === body.password);
    if (!account) throw new Error("Invalid username or password.");
    return publicAccount(account);
  }

  if (url.pathname === "/api/profile" && method === "GET") {
    const account = findAccount(url.searchParams.get("accountId"));
    return { account: publicAccount(account), stats: staticStats(account.id) };
  }

  if (path === "/api/profile" && method === "PATCH") {
    const account = findAccount(body.accountId);
    account.displayName = body.displayName;
    account.bio = body.bio || "";
    saveStaticData();
    return publicAccount(account);
  }

  if (url.pathname === "/api/accounts/search") {
    const accountId = Number(url.searchParams.get("accountId"));
    const q = normalizeUsername(url.searchParams.get("q") || "");
    return data.accounts
      .filter((account) => account.id !== accountId && account.username.includes(q))
      .slice(0, 12)
      .map((account) => ({ ...publicAccount(account), friendshipStatus: staticFriendshipStatus(accountId, account.id) }));
  }

  if (url.pathname === "/api/friend-requests" && method === "GET") {
    return staticRequests(Number(url.searchParams.get("accountId")));
  }

  if (path === "/api/friend-requests" && method === "POST") {
    const receiver = data.accounts.find((account) => account.username === normalizeUsername(body.receiverUsername));
    if (!receiver) throw new Error("User not found.");
    if (receiver.id === Number(body.accountId)) throw new Error("You cannot add yourself.");
    const status = staticFriendshipStatus(Number(body.accountId), receiver.id);
    if (status !== "none") throw new Error(status === "friends" ? "You are already friends." : "A pending request already exists.");
    data.friendRequests.push({
      id: data.nextId++,
      requesterId: Number(body.accountId),
      receiverId: receiver.id,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    saveStaticData();
    return staticRequests(Number(body.accountId));
  }

  if (url.pathname.endsWith("/accept") && method === "POST") {
    const username = decodeURIComponent(url.pathname.split("/").at(-2));
    const requester = data.accounts.find((account) => account.username === username);
    const requestItem = data.friendRequests.find((item) => requester && item.requesterId === requester.id && item.receiverId === Number(body.accountId) && item.status === "pending");
    if (!requestItem) throw new Error("No incoming request found.");
    requestItem.status = "accepted";
    requestItem.updatedAt = new Date().toISOString();
    saveStaticData();
    return staticRequests(Number(body.accountId));
  }

  if (url.pathname === "/api/inbox") return staticInbox(Number(url.searchParams.get("accountId")));

  if (url.pathname.startsWith("/api/messages/") && method === "GET") {
    return staticConversation(Number(url.searchParams.get("accountId")), decodeURIComponent(url.pathname.split("/").pop()));
  }

  if (path === "/api/messages" && method === "POST") {
    const conversation = staticConversation(Number(body.accountId), body.receiverUsername);
    data.messages.push({
      id: data.nextId++,
      senderId: Number(body.accountId),
      receiverId: conversation.friend.id,
      content: body.content,
      createdAt: new Date().toISOString()
    });
    saveStaticData();
    return staticConversation(Number(body.accountId), body.receiverUsername);
  }

  throw new Error("Local-only mode does not support that action.");
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function findAccount(accountId) {
  const account = state.staticData.accounts.find((item) => item.id === Number(accountId));
  if (!account) throw new Error("Account not found.");
  return account;
}

function staticFriendshipStatus(accountId, otherId) {
  const item = state.staticData.friendRequests.find((requestItem) =>
    ((requestItem.requesterId === Number(accountId) && requestItem.receiverId === Number(otherId)) ||
      (requestItem.requesterId === Number(otherId) && requestItem.receiverId === Number(accountId))) &&
    ["pending", "accepted"].includes(requestItem.status)
  );
  if (!item) return "none";
  if (item.status === "accepted") return "friends";
  return item.requesterId === Number(accountId) ? "outgoing" : "incoming";
}

function staticRequests(accountId) {
  const toRequest = (item) => ({
    id: item.id,
    status: item.status,
    createdAt: item.createdAt,
    account: publicAccount(findAccount(item.requesterId === accountId ? item.receiverId : item.requesterId))
  });
  return {
    incoming: state.staticData.friendRequests.filter((item) => item.receiverId === accountId && item.status === "pending").map(toRequest),
    outgoing: state.staticData.friendRequests.filter((item) => item.requesterId === accountId && item.status === "pending").map(toRequest)
  };
}

function staticInbox(accountId) {
  return state.staticData.friendRequests
    .filter((item) => item.status === "accepted" && (item.requesterId === accountId || item.receiverId === accountId))
    .map((item) => {
      const friendId = item.requesterId === accountId ? item.receiverId : item.requesterId;
      const latest = [...state.staticData.messages]
        .filter((message) => (message.senderId === accountId && message.receiverId === friendId) || (message.senderId === friendId && message.receiverId === accountId))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      return { friend: publicAccount(findAccount(friendId)), latestMessage: latest ? latest.content : "", latestAt: latest ? latest.createdAt : null };
    })
    .sort((a, b) => new Date(b.latestAt || 0) - new Date(a.latestAt || 0));
}

function staticConversation(accountId, username) {
  const friend = state.staticData.accounts.find((account) => account.username === normalizeUsername(username));
  if (!friend) throw new Error("User not found.");
  if (staticFriendshipStatus(accountId, friend.id) !== "friends") throw new Error("You can only message accepted friends.");
  return {
    friend: publicAccount(friend),
    messages: state.staticData.messages
      .filter((message) => (message.senderId === accountId && message.receiverId === friend.id) || (message.senderId === friend.id && message.receiverId === accountId))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  };
}

function staticStats(accountId) {
  const friends = state.staticData.friendRequests.filter((item) => item.status === "accepted" && (item.requesterId === accountId || item.receiverId === accountId)).length;
  const messages = state.staticData.messages.filter((item) => item.senderId === accountId || item.receiverId === accountId);
  const chats = new Set(messages.map((item) => item.senderId === accountId ? item.receiverId : item.senderId)).size;
  return { friends, chats, messages: messages.length };
}

function initials(account) {
  return (account.displayName || account.username || "?").trim().charAt(0).toUpperCase();
}

function setSession(account) {
  state.account = account;
  if (account) localStorage.setItem(SESSION_KEY, JSON.stringify(account));
  else localStorage.removeItem(SESSION_KEY);
  renderAuthState();
}

function renderAuthState() {
  const loggedIn = Boolean(state.account);
  el.authPanel.classList.toggle("hidden", loggedIn);
  el.profilePanel.classList.toggle("hidden", !loggedIn);
  document.querySelectorAll(".message-form input, .message-form button").forEach((node) => {
    node.disabled = !state.activeChat;
  });
  if (loggedIn) refreshAll();
}

async function refreshAll() {
  if (!state.account) return;
  await Promise.all([loadProfile(), loadInbox(), loadRequests()]);
  const userParam = params.get("user");
  if (userParam && !refreshAll.userOpened) {
    refreshAll.userOpened = true;
    switchView("friends");
    el.searchInput.value = userParam;
    searchUsers();
  }
}

async function loadProfile() {
  const profile = await request(`/api/profile?accountId=${state.account.id}`);
  state.profile = profile;
  state.account = profile.account;
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.account));
  el.profileName.textContent = profile.account.displayName;
  el.profileUsername.textContent = `@${profile.account.username}`;
  el.profileBio.textContent = profile.account.bio || "No bio yet.";
  el.profileAvatar.textContent = initials(profile.account);
  el.profileForm.displayName.value = profile.account.displayName;
  el.profileForm.bio.value = profile.account.bio || "";
  el.statFriends.textContent = profile.stats.friends;
  el.statChats.textContent = profile.stats.chats;
  el.statMessages.textContent = profile.stats.messages;
  el.topSubtitle.textContent = `@${profile.account.username}`;
}

async function loadInbox() {
  const inbox = await request(`/api/inbox?accountId=${state.account.id}`);
  el.inboxList.innerHTML = "";
  el.emptyInbox.classList.toggle("hidden", inbox.length > 0);
  inbox.forEach((item) => {
    const row = document.createElement("button");
    row.className = `chat-row ${state.activeChat === item.friend.username ? "active" : ""}`;
    row.type = "button";
    row.innerHTML = rowTemplate(item.friend, item.latestMessage || "Start the conversation");
    row.addEventListener("click", () => openChat(item.friend.username));
    el.inboxList.append(row);
  });
}

async function loadRequests() {
  const requests = await request(`/api/friend-requests?accountId=${state.account.id}`);
  renderRequestList(el.incomingRequests, requests.incoming, true);
  renderRequestList(el.outgoingRequests, requests.outgoing, false);
}

function renderRequestList(container, requests, incoming) {
  container.innerHTML = "";
  if (!requests.length) {
    container.innerHTML = `<div class="empty-state">${incoming ? "No incoming requests." : "No outgoing requests."}</div>`;
    return;
  }
  requests.forEach((item) => {
    const row = document.createElement("div");
    row.className = "request-row";
    row.innerHTML = rowTemplate(item.account, incoming ? "Wants to connect" : "Request pending");
    if (incoming) {
      const button = document.createElement("button");
      button.className = "row-action";
      button.textContent = "Accept";
      button.addEventListener("click", () => acceptRequest(item.account.username));
      row.append(button);
    }
    container.append(row);
  });
}

function rowTemplate(account, subtitle) {
  return `
    <div class="mini-avatar">${initials(account)}</div>
    <div>
      <p class="row-title">${escapeHtml(account.displayName)}</p>
      <p class="row-subtitle">@${escapeHtml(account.username)} · ${escapeHtml(subtitle || account.bio || "")}</p>
    </div>
  `;
}

async function searchUsers(event) {
  if (event) event.preventDefault();
  if (!state.account) return showStatus("Login to search users.");
  const q = normalizeUsername(el.searchInput.value);
  const accounts = await request(`/api/accounts/search?accountId=${state.account.id}&q=${encodeURIComponent(q)}`);
  el.searchResults.innerHTML = "";
  if (!accounts.length) {
    el.searchResults.innerHTML = '<div class="empty-state">No matching usernames.</div>';
    return;
  }
  accounts.forEach((account) => {
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = rowTemplate(account, account.bio || statusLabel(account.friendshipStatus));
    const button = document.createElement("button");
    button.className = "row-action";
    button.textContent = actionLabel(account.friendshipStatus);
    button.disabled = account.friendshipStatus !== "none";
    button.addEventListener("click", () => sendRequest(account.username));
    row.append(button);
    el.searchResults.append(row);
  });
}

function statusLabel(status) {
  return { friends: "Friends", outgoing: "Request sent", incoming: "Sent you a request", none: "Available" }[status] || "Available";
}

function actionLabel(status) {
  return { friends: "Friends", outgoing: "Pending", incoming: "Respond", none: "Add" }[status] || "Add";
}

async function sendRequest(username) {
  await request("/api/friend-requests", {
    method: "POST",
    body: JSON.stringify({ accountId: state.account.id, receiverUsername: username })
  });
  showStatus("Friend request sent.");
  await Promise.all([searchUsers(), loadRequests()]);
}

async function acceptRequest(username) {
  await request(`/api/friend-requests/${encodeURIComponent(username)}/accept`, {
    method: "POST",
    body: JSON.stringify({ accountId: state.account.id })
  });
  showStatus("Friend request accepted.");
  await refreshAll();
}

async function openChat(username) {
  state.activeChat = username;
  const conversation = await request(`/api/messages/${encodeURIComponent(username)}?accountId=${state.account.id}`);
  el.chatName.textContent = conversation.friend.displayName;
  el.chatUsername.textContent = `@${conversation.friend.username}`;
  el.chatAvatar.textContent = initials(conversation.friend);
  el.messageInput.disabled = false;
  el.sendButton.disabled = false;
  renderMessages(conversation.messages);
  el.chatPanel.classList.add("open");
  clearInterval(state.poll);
  state.poll = setInterval(() => pollConversation(), 2500);
  await loadInbox();
}

async function pollConversation() {
  if (!state.activeChat || !state.account) return;
  try {
    const conversation = await request(`/api/messages/${encodeURIComponent(state.activeChat)}?accountId=${state.account.id}`);
    renderMessages(conversation.messages);
  } catch (error) {
    console.warn(error);
  }
}

function renderMessages(messages) {
  el.messagesList.innerHTML = "";
  if (!messages.length) {
    el.messagesList.innerHTML = '<div class="empty-state">No messages yet.</div>';
    return;
  }
  messages.forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.senderId === state.account.id ? "mine" : "theirs"}`;
    bubble.textContent = message.content;
    el.messagesList.append(bubble);
  });
  el.messagesList.scrollTop = el.messagesList.scrollHeight;
}

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}View`));
  document.querySelectorAll(".tab, .bottom-tab").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  if (view === "requests" && state.account) loadRequests();
  if (view === "chats" && state.account) loadInbox();
  el.sidebar.classList.remove("open");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

document.querySelectorAll(".auth-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((node) => node.classList.toggle("active", node === button));
    el.loginForm.classList.toggle("hidden", button.dataset.auth !== "login");
    el.signupForm.classList.toggle("hidden", button.dataset.auth !== "signup");
  });
});

document.querySelectorAll(".tab, .bottom-tab").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(el.loginForm);
    const account = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
    });
    setSession(account);
    showStatus("Logged in.");
  } catch (error) {
    showStatus(error.message);
  }
});

el.signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(el.signupForm);
    const account = await request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        displayName: form.get("displayName"),
        username: form.get("username"),
        password: form.get("password"),
        bio: form.get("bio")
      })
    });
    setSession(account);
    showStatus("Account created.");
  } catch (error) {
    showStatus(error.message);
  }
});

el.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(el.profileForm);
    const account = await request("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ accountId: state.account.id, displayName: form.get("displayName"), bio: form.get("bio") })
    });
    setSession(account);
    showStatus("Profile saved.");
  } catch (error) {
    showStatus(error.message);
  }
});

el.searchForm.addEventListener("submit", searchUsers);

el.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = el.messageInput.value.trim();
  if (!content || !state.activeChat) return;
  try {
    const conversation = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({ accountId: state.account.id, receiverUsername: state.activeChat, content })
    });
    el.messageInput.value = "";
    renderMessages(conversation.messages);
    await loadInbox();
  } catch (error) {
    showStatus(error.message);
  }
});

document.getElementById("logoutButton").addEventListener("click", () => {
  clearInterval(state.poll);
  state.activeChat = null;
  setSession(null);
  showStatus("Logged out.");
});

document.getElementById("shareProfile").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?user=${encodeURIComponent(state.account.username)}`;
  try {
    await navigator.clipboard.writeText(url);
    showStatus("Profile link copied.");
  } catch {
    showStatus(url);
  }
});

document.getElementById("profileToggle").addEventListener("click", () => el.sidebar.classList.toggle("open"));
document.getElementById("composeButton").addEventListener("click", () => switchView("friends"));
document.getElementById("backToInbox").addEventListener("click", () => el.chatPanel.classList.remove("open"));

window.addEventListener("beforeunload", () => clearInterval(state.poll));

try {
  const session = JSON.parse(localStorage.getItem(SESSION_KEY));
  if (session) setSession(session);
} catch {
  localStorage.removeItem(SESSION_KEY);
}
