const euro = (n) => `${Number(n || 0).toFixed(2)} €`;

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function loadStats() {
  const s = await fetchJSON("/api/stats");
  document.getElementById("stat-earned").textContent = euro(s.droppedValue);
  document.getElementById("stat-earned-count").textContent = `${s.droppedCount} colis dropés`;
  document.getElementById("stat-pending").textContent = s.pendingCount;
  document.getElementById("stat-pending-value").textContent = `≈ ${euro(s.pendingValue)} potentiels`;
  document.getElementById("stat-today").textContent = euro(s.todayValue);
  document.getElementById("stat-today-count").textContent = `${s.todayCount} colis dropés`;

  const tbody = document.querySelector("#sender-table tbody");
  tbody.innerHTML = "";
  if (s.bySender.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Aucun colis pour le moment</td></tr>`;
  }
  for (const row of s.bySender) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.sender_name)}</td>
      <td>${row.pending_count}</td>
      <td>${euro(row.pending_value)}</td>
      <td>${row.dropped_count}</td>
      <td>${euro(row.dropped_value)}</td>
      <td>${row.pending_count > 0 ? `<button class="btn btn-small btn-ghost" data-drop-sender="${escapeAttr(row.sender_name)}">Dropper</button>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadColis() {
  const rows = await fetchJSON("/api/colis?status=pending");
  const tbody = document.querySelector("#colis-table tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Rien à dropper 🎉</td></tr>`;
  }
  for (const c of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>#${c.id}</td>
      <td>${escapeHtml(c.sender_name)}</td>
      <td>${euro(c.price)}</td>
      <td>${new Date(c.created_at + "Z").toLocaleString("fr-FR")}</td>
      <td><button class="btn btn-small btn-primary" data-drop-id="${c.id}">Dropé</button></td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadSenders() {
  const rows = await fetchJSON("/api/senders");
  const tbody = document.querySelector("#settings-table tbody");
  tbody.innerHTML = "";
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.name)}</td>
      <td><input class="price-input" type="number" step="0.5" min="0" value="${s.price}" data-sender-id="${s.id}" /></td>
      <td><button class="btn btn-small btn-ghost" data-delete-sender="${s.id}">Supprimer</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

async function refreshAll() {
  await Promise.all([loadStats(), loadColis(), loadSenders()]);
}

document.addEventListener("click", async (e) => {
  const dropId = e.target.dataset.dropId;
  const dropSender = e.target.dataset.dropSender;
  const deleteSender = e.target.dataset.deleteSender;

  if (dropId) {
    await fetchJSON(`/api/colis/${dropId}/drop`, { method: "POST" });
    refreshAll();
  } else if (dropSender) {
    await fetchJSON(`/api/colis/drop-sender/${encodeURIComponent(dropSender)}`, { method: "POST" });
    refreshAll();
  } else if (deleteSender) {
    if (confirm("Supprimer cet expéditeur ?")) {
      await fetchJSON(`/api/senders/${deleteSender}`, { method: "DELETE" });
      refreshAll();
    }
  } else if (e.target.id === "drop-all-btn") {
    if (confirm("Marquer TOUS les colis en attente comme dropés ?")) {
      await fetchJSON("/api/colis/drop-all", { method: "POST" });
      refreshAll();
    }
  }
});

document.addEventListener("change", async (e) => {
  const senderId = e.target.dataset.senderId;
  if (senderId) {
    await fetchJSON(`/api/senders/${senderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: Number(e.target.value) }),
    });
    loadStats();
  }
});

document.getElementById("add-sender-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("new-sender-name").value.trim();
  const price = Number(document.getElementById("new-sender-price").value);
  try {
    await fetchJSON("/api/senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price }),
    });
    e.target.reset();
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

refreshAll();
setInterval(refreshAll, 5000);
