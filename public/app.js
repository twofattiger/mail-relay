import { renderMailBody } from "/mail-frame.js";

const app = document.getElementById("app");
const state = { authed: false, route: "", folder: "inbox", page: 1, q: "" };

// ── fetch 封装 ──
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    state.authed = false;
    renderLogin();
    throw new Error("未登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.onclick = v;
    else if (k === "html") node.innerHTML = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ── 登录 ──
function renderLogin() {
  const err = el("div", { class: "msg-error" });
  const pwd = el("input", { type: "password", placeholder: "管理口令" });
  const submit = async () => {
    err.textContent = "";
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: pwd.value }),
      });
      state.authed = true;
      location.hash = "#/inbox";
      renderApp();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  pwd.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  app.innerHTML = "";
  app.appendChild(
    el(
      "div",
      { class: "login-wrap" },
      el(
        "div",
        { class: "login-card" },
        el("h1", {}, "mail-relay"),
        el("div", { class: "field" }, el("label", {}, "口令"), pwd),
        err,
        el("button", { class: "primary", onclick: submit, style: "width:100%" }, "登录"),
      ),
    ),
  );
}

// ── 主框架 ──
const NAV = [
  { key: "inbox", label: "收件箱", folder: "inbox" },
  { key: "sent", label: "已发送", folder: "sent" },
  { key: "spam", label: "垃圾邮件", folder: "spam" },
  { key: "trash", label: "废纸篓", folder: "trash" },
  { key: "providers", label: "发送通道" },
  { key: "rules", label: "收信规则" },
  { key: "forward-rules", label: "转发规则" },
];

function renderShell(activeKey, contentNode) {
  const sidebar = el("div", { class: "sidebar" }, el("div", { class: "brand" }, "📮 mail-relay"));
  for (const n of NAV) {
    sidebar.appendChild(
      el(
        "button",
        {
          class: "nav-item" + (n.key === activeKey ? " active" : ""),
          onclick: () => (location.hash = "#/" + n.key),
        },
        n.label,
      ),
    );
  }
  sidebar.appendChild(el("div", { class: "spacer" }));
  sidebar.appendChild(
    el(
      "button",
      {
        class: "nav-item",
        onclick: async () => {
          if (!confirm("确定要退出登录吗？")) return;
          await api("/api/logout", { method: "POST" });
          state.authed = false;
          renderLogin();
        },
      },
      "退出登录",
    ),
  );
  app.innerHTML = "";
  app.appendChild(el("div", { class: "layout" }, sidebar, el("div", { class: "main" }, contentNode)));
}

// ── 邮件列表 ──
async function renderMailList(folder) {
  state.folder = folder;
  const activeKey = NAV.find((n) => n.folder === folder)?.key ?? "inbox";
  const content = el("div", {});
  renderShell(activeKey, content);

  const search = el("input", {
    class: "search",
    placeholder: "搜索主题/发件人…",
    value: state.q,
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.q = search.value;
      state.page = 1;
      renderMailList(folder);
    }
  });
  const toolbar = el(
    "div",
    { class: "toolbar" },
    el("h2", {}, NAV.find((n) => n.folder === folder)?.label ?? "邮件"),
    search,
    el("button", { class: "primary", onclick: () => openCompose() }, "✏️ 写邮件"),
  );
  content.appendChild(toolbar);

  const listBox = el("div", { class: "mail-list" }, el("div", { class: "empty" }, "加载中…"));
  content.appendChild(listBox);

  try {
    const params = new URLSearchParams({
      folder,
      page: state.page,
      pageSize: 20,
    });
    if (state.q) params.set("q", state.q);
    const data = await api("/api/mails?" + params.toString());
    listBox.innerHTML = "";
    if (!data.items.length) {
      listBox.appendChild(el("div", { class: "empty" }, "没有邮件"));
    } else {
      for (const m of data.items) {
        const who = m.direction === "out" ? "→ " + m.to_addr : m.from_addr;
        listBox.appendChild(
          el(
            "div",
            {
              class: "mail-row" + (m.is_read ? "" : " unread"),
              onclick: () => (location.hash = "#/mail/" + m.id),
            },
            el("div", { class: "from" }, who),
            el(
              "div",
              { class: "subj" },
              m.has_attachments ? el("span", { class: "clip" }, "📎") : null,
              el("span", {}, m.subject || "(无主题)"),
              el("span", { class: "snippet" }, m.snippet || ""),
            ),
            el("div", { class: "meta" }, fmtDate(m.created_at)),
          ),
        );
      }
    }
    content.appendChild(renderPager(data, () => renderMailList(folder)));
  } catch (e) {
    listBox.innerHTML = "";
    listBox.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

function renderPager(data, reload) {
  const prev = el(
    "button",
    {
      onclick: () => {
        if (state.page > 1) {
          state.page--;
          reload();
        }
      },
    },
    "‹ 上一页",
  );
  prev.disabled = data.page <= 1;
  const next = el(
    "button",
    {
      onclick: () => {
        if (data.page < data.totalPages) {
          state.page++;
          reload();
        }
      },
    },
    "下一页 ›",
  );
  next.disabled = data.page >= data.totalPages;
  return el(
    "div",
    { class: "pager" },
    prev,
    el("span", {}, `第 ${data.page} / ${data.totalPages} 页 · 共 ${data.total} 封`),
    next,
  );
}

// ── 邮件详情 ──
async function renderDetail(id) {
  renderShell(NAV.find((n) => n.folder === state.folder)?.key ?? "inbox", el("div", {}, "加载中…"));
  try {
    const m = await api("/api/mails/" + id);
    const content = el("div", {});
    renderShell(NAV.find((n) => n.folder === state.folder)?.key ?? "inbox", content);

    content.appendChild(
      el(
        "div",
        { class: "toolbar" },
        el("button", { onclick: () => history.back() }, "‹ 返回"),
        el("div", { style: "flex:1" }),
        el("button", { onclick: () => openCompose({ replyTo: m }) }, "↩︎ 回复"),
      ),
    );

    const detail = el("div", { class: "detail" });
    detail.appendChild(el("h2", {}, m.subject || "(无主题)"));
    detail.appendChild(el("div", { class: "hdr-row" }, "发件人：" + m.from_addr));
    detail.appendChild(el("div", { class: "hdr-row" }, "收件人：" + m.to_addr));
    detail.appendChild(el("div", { class: "hdr-row" }, "时间：" + new Date(m.created_at).toLocaleString("zh-CN")));

    if (m.needs_parse) {
      detail.appendChild(
        el("div", { class: "banner" }, "此邮件解析失败，请下载原始 .eml 查看。"),
      );
    }

    // 附件
    if (m.attachments && m.attachments.length) {
      const attBox = el("div", { class: "att-list" });
      for (const a of m.attachments) {
        attBox.appendChild(
          el(
            "a",
            { class: "att-chip", href: "/api/att/" + a.id, target: "_blank" },
            `📎 ${a.filename}` + (a.size_bytes ? ` (${fmtSize(a.size_bytes)})` : ""),
          ),
        );
      }
      detail.appendChild(attBox);
    }

    // 正文（安全渲染）
    const bodyBox = el("div", {});
    detail.appendChild(bodyBox);
    renderMailBody(bodyBox, m.body_html, m.body_text);

    // 原始邮件下载
    if (m.raw_r2_key) {
      detail.appendChild(
        el(
          "div",
          { style: "margin-top:16px" },
          el("a", { href: "/api/raw/" + m.id, target: "_blank" }, "下载原始 .eml"),
        ),
      );
    }

    content.appendChild(detail);
  } catch (e) {
    renderShell("inbox", el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ── 撰写 / 回复 ──
function openCompose(opts = {}) {
  const reply = opts.replyTo;
  const to = el("input", {
    placeholder: "收件人，多个用逗号分隔",
    value: reply ? reply.from_addr : "",
  });
  const from = el("input", {
    placeholder: "发件人，如 me@yourdomain.com",
    value: reply ? reply.to_addr.split(",")[0].trim() : "",
  });
  const subject = el("input", {
    placeholder: "主题",
    value: reply ? (reply.subject?.startsWith("Re:") ? reply.subject : "Re: " + (reply.subject || "")) : "",
  });
  const bodyText = el("textarea", { rows: "10", placeholder: "正文（纯文本）" });
  const err = el("div", { class: "msg-error" });

  const mask = el("div", { class: "modal-mask" });
  const close = () => mask.remove();

  const sendBtn = el(
    "button",
    { class: "primary" },
    reply ? "发送回复" : "发送",
  );
  sendBtn.onclick = async () => {
    err.textContent = "";
    sendBtn.disabled = true;
    try {
      const payload = {
        to: to.value.split(",").map((s) => s.trim()).filter(Boolean),
        from: from.value.trim(),
        subject: subject.value,
        text: bodyText.value,
      };
      if (reply) payload.replyToMailId = reply.id;
      const res = await api("/api/send", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      close();
      alert(
        res.status === "sent"
          ? "已发送"
          : res.status === "queued"
            ? "已进入重试队列：" + (res.error || "")
            : "发送失败：" + (res.error || ""),
      );
      if (state.route.startsWith("inbox") || state.route === "sent") renderMailList(state.folder);
    } catch (e) {
      err.textContent = e.message;
      sendBtn.disabled = false;
    }
  };

  mask.appendChild(
    el(
      "div",
      { class: "modal" },
      el("h3", {}, reply ? "回复邮件" : "撰写邮件"),
      el("div", { class: "field" }, el("label", {}, "发件人"), from),
      el("div", { class: "field" }, el("label", {}, "收件人"), to),
      el("div", { class: "field" }, el("label", {}, "主题"), subject),
      el("div", { class: "field" }, el("label", {}, "正文"), bodyText),
      err,
      el(
        "div",
        { class: "modal-actions" },
        el("button", { onclick: close }, "取消"),
        sendBtn,
      ),
    ),
  );
  mask.addEventListener("click", (e) => e.target === mask && close());
  document.body.appendChild(mask);
}

// ── 发送通道（Providers）──
async function renderProviders() {
  const content = el("div", {});
  renderShell("providers", content);
  content.appendChild(
    el(
      "div",
      { class: "toolbar" },
      el("h2", {}, "发送通道"),
      el("button", { class: "primary", onclick: () => openProviderForm() }, "＋ 新增通道"),
    ),
  );
  const box = el("div", {}, "加载中…");
  content.appendChild(box);
  try {
    const data = await api("/api/providers");
    box.innerHTML = "";
    if (!data.items.length) {
      box.appendChild(el("div", { class: "empty" }, "还没有配置发送通道，点击右上角新增。"));
      return;
    }
    const rows = data.items.map((p) =>
      el(
        "tr",
        {},
        el("td", {}, p.name),
        el("td", {}, p.type),
        el(
          "td",
          {},
          p.is_active ? el("span", { class: "badge active" }, "激活中") : "—",
        ),
        el(
          "td",
          {},
          p.last_verified_at
            ? new Date(p.last_verified_at).toLocaleString("zh-CN")
            : "未验证",
        ),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            el("button", { onclick: () => verifyProvider(p.id) }, "测试"),
            p.is_active
              ? null
              : el("button", { onclick: () => activateProvider(p.id) }, "激活"),
            el("button", { onclick: () => openProviderForm(p) }, "编辑"),
            el("button", { class: "danger", onclick: () => delProvider(p.id) }, "删除"),
          ),
        ),
      ),
    );
    box.appendChild(
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "名称"),
            el("th", {}, "类型"),
            el("th", {}, "状态"),
            el("th", {}, "最近验证"),
            el("th", {}, "操作"),
          ),
        ),
        el("tbody", {}, ...rows),
      ),
    );
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

async function verifyProvider(id) {
  try {
    const res = await fetch("/api/providers/" + id + "/verify", { method: "POST" });
    const data = await res.json();
    alert(data.ok ? "连接正常 ✓" : "验证失败：" + (data.error || ""));
    renderProviders();
  } catch (e) {
    alert("验证出错：" + e.message);
  }
}
async function activateProvider(id) {
  await api("/api/providers/" + id + "/activate", { method: "POST" });
  renderProviders();
}
async function delProvider(id) {
  if (!confirm("确定删除该通道？")) return;
  try {
    await api("/api/providers/" + id, { method: "DELETE" });
    renderProviders();
  } catch (e) {
    alert(e.message);
  }
}

async function openProviderForm(existing) {
  const schemas = (await api("/api/providers/schema")).items;
  const err = el("div", { class: "msg-error" });
  const typeSel = el("select", {});
  for (const s of schemas) {
    const opt = el("option", { value: s.type }, s.displayName);
    if (existing && existing.type === s.type) opt.selected = true;
    typeSel.appendChild(opt);
  }
  if (existing) typeSel.disabled = true;

  const nameInput = el("input", { placeholder: "显示名，如 Resend 主账号", value: existing?.name || "" });
  const fieldsBox = el("div", {});

  function drawFields() {
    const schema = schemas.find((s) => s.type === typeSel.value);
    fieldsBox.innerHTML = "";
    for (const f of schema.configSchema) {
      const input = el("input", {
        type: f.secret ? "password" : "text",
        placeholder: f.placeholder || "",
        value: existing?.config?.[f.key] && !f.secret ? existing.config[f.key] : "",
      });
      input.dataset.key = f.key;
      input.dataset.secret = f.secret ? "1" : "";
      const field = el(
        "div",
        { class: "field" },
        el("label", {}, f.label + (f.required ? " *" : "")),
        input,
      );
      if (f.secret && existing) {
        field.appendChild(el("div", { class: "hint" }, "留空表示不修改现有密钥"));
      }
      fieldsBox.appendChild(field);
    }
  }
  typeSel.onchange = drawFields;
  drawFields();

  const mask = el("div", { class: "modal-mask" });
  const close = () => mask.remove();
  const saveBtn = el("button", { class: "primary" }, "保存");
  saveBtn.onclick = async () => {
    err.textContent = "";
    saveBtn.disabled = true;
    const config = {};
    for (const input of fieldsBox.querySelectorAll("input")) {
      const val = input.value;
      // secret 留空则不提交（更新时表示不变更）
      if (input.dataset.secret && val === "") continue;
      config[input.dataset.key] = val;
    }
    try {
      if (existing) {
        await api("/api/providers/" + existing.id, {
          method: "PUT",
          body: JSON.stringify({ name: nameInput.value, config }),
        });
      } else {
        await api("/api/providers", {
          method: "POST",
          body: JSON.stringify({ type: typeSel.value, name: nameInput.value, config }),
        });
      }
      close();
      renderProviders();
    } catch (e) {
      err.textContent = e.message;
      saveBtn.disabled = false;
    }
  };

  mask.appendChild(
    el(
      "div",
      { class: "modal" },
      el("h3", {}, existing ? "编辑通道" : "新增通道"),
      el("div", { class: "field" }, el("label", {}, "类型"), typeSel),
      el("div", { class: "field" }, el("label", {}, "名称"), nameInput),
      fieldsBox,
      err,
      el("div", { class: "modal-actions" }, el("button", { onclick: close }, "取消"), saveBtn),
    ),
  );
  mask.addEventListener("click", (e) => e.target === mask && close());
  document.body.appendChild(mask);
}

// ── 收信规则 ──
async function renderRules() {
  const content = el("div", {});
  renderShell("rules", content);
  content.appendChild(
    el(
      "div",
      { class: "toolbar" },
      el("h2", {}, "收信规则"),
      el("button", { class: "primary", onclick: () => openRuleForm() }, "＋ 新增规则"),
    ),
  );
  const box = el("div", {}, "加载中…");
  content.appendChild(box);
  try {
    const data = await api("/api/rules?page=" + state.page + "&pageSize=20");
    box.innerHTML = "";
    if (!data.items.length) {
      box.appendChild(el("div", { class: "empty" }, "暂无规则。规则可用于拒收、标记垃圾或归档。"));
      return;
    }
    const rows = data.items.map((r) =>
      el(
        "tr",
        {},
        el("td", {}, kindLabel(r.kind)),
        el("td", {}, r.pattern),
        el("td", {}, actionLabel(r.action)),
        el("td", {}, r.enabled ? "启用" : "停用"),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            el("button", { onclick: () => openRuleForm(r) }, "编辑"),
            el("button", { class: "danger", onclick: () => delRule(r.id) }, "删除"),
          ),
        ),
      ),
    );
    box.appendChild(
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "匹配字段"),
            el("th", {}, "包含"),
            el("th", {}, "动作"),
            el("th", {}, "状态"),
            el("th", {}, "操作"),
          ),
        ),
        el("tbody", {}, ...rows),
      ),
    );
    content.appendChild(renderPager(data, renderRules));
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

const kindLabel = (k) =>
  ({ from: "发件人", to: "收件人", subject: "主题" })[k] || "任意";
const actionLabel = (a) =>
  ({ reject: "拒收", spam: "标记垃圾", trash: "移入废纸篓" })[a] || a;

function openRuleForm(existing) {
  const kind = el("select", {});
  for (const [v, l] of [["from", "发件人"], ["to", "收件人"], ["subject", "主题"], ["any", "任意"]]) {
    const opt = el("option", { value: v }, l);
    if (existing?.kind === v) opt.selected = true;
    kind.appendChild(opt);
  }
  const pattern = el("input", { placeholder: "包含的关键字", value: existing?.pattern || "" });
  const action = el("select", {});
  for (const [v, l] of [["reject", "拒收"], ["spam", "标记垃圾"], ["trash", "移入废纸篓"]]) {
    const opt = el("option", { value: v }, l);
    if (existing?.action === v) opt.selected = true;
    action.appendChild(opt);
  }
  const enabled = el("select", {});
  for (const [v, l] of [["1", "启用"], ["0", "停用"]]) {
    const opt = el("option", { value: v }, l);
    if (existing && String(existing.enabled) === v) opt.selected = true;
    enabled.appendChild(opt);
  }
  const err = el("div", { class: "msg-error" });

  const mask = el("div", { class: "modal-mask" });
  const close = () => mask.remove();
  const saveBtn = el("button", { class: "primary" }, "保存");
  saveBtn.onclick = async () => {
    err.textContent = "";
    try {
      const payload = {
        kind: kind.value,
        pattern: pattern.value,
        action: action.value,
        enabled: enabled.value === "1",
      };
      const url = existing ? "/api/rules/" + existing.id : "/api/rules";
      await api(url, { method: existing ? "PUT" : "POST", body: JSON.stringify(payload) });
      close();
      renderRules();
    } catch (e) {
      err.textContent = e.message;
    }
  };

  mask.appendChild(
    el(
      "div",
      { class: "modal" },
      el("h3", {}, existing ? "编辑规则" : "新增规则"),
      el("div", { class: "field" }, el("label", {}, "匹配字段"), kind),
      el("div", { class: "field" }, el("label", {}, "包含关键字"), pattern),
      el("div", { class: "field" }, el("label", {}, "动作"), action),
      el("div", { class: "field" }, el("label", {}, "状态"), enabled),
      err,
      el("div", { class: "modal-actions" }, el("button", { onclick: close }, "取消"), saveBtn),
    ),
  );
  mask.addEventListener("click", (e) => e.target === mask && close());
  document.body.appendChild(mask);
}

async function delRule(id) {
  if (!confirm("确定删除该规则？")) return;
  await api("/api/rules/" + id, { method: "DELETE" });
  renderRules();
}

// ── 转发规则 ──
async function renderForwardRules() {
  const content = el("div", {});
  renderShell("forward-rules", content);
  content.appendChild(
    el(
      "div",
      { class: "toolbar" },
      el("h2", {}, "转发规则"),
      el("button", { class: "primary", onclick: () => openForwardRuleForm() }, "＋ 新增转发"),
    ),
  );
  content.appendChild(
    el(
      "div",
      { class: "empty", style: "margin-bottom:12px" },
      "按邮件头 发件人/收件人 匹配来信并转发到指定邮箱（包含子串、大小写不敏感）。目标地址须为 Cloudflare 邮箱路由里已验证的 Destination，否则转发会失败。",
    ),
  );
  const box = el("div", {}, "加载中…");
  content.appendChild(box);
  try {
    const data = await api("/api/forward-rules?page=" + state.page + "&pageSize=20");
    box.innerHTML = "";
    if (!data.items.length) {
      box.appendChild(el("div", { class: "empty" }, "暂无转发规则。"));
      return;
    }
    const rows = data.items.map((r) =>
      el(
        "tr",
        {},
        el("td", {}, r.match_from || "任意"),
        el("td", {}, r.match_to || "任意"),
        el("td", {}, r.target),
        el("td", {}, r.keep_original ? "转发并存档" : "转发后不存档"),
        el("td", {}, r.enabled ? "启用" : "停用"),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            el("button", { onclick: () => openForwardRuleForm(r) }, "编辑"),
            el("button", { class: "danger", onclick: () => delForwardRule(r.id) }, "删除"),
          ),
        ),
      ),
    );
    box.appendChild(
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "发件人含"),
            el("th", {}, "收件人含"),
            el("th", {}, "转发到"),
            el("th", {}, "原件"),
            el("th", {}, "状态"),
            el("th", {}, "操作"),
          ),
        ),
        el("tbody", {}, ...rows),
      ),
    );
    content.appendChild(renderPager(data, renderForwardRules));
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

function openForwardRuleForm(existing) {
  const matchFrom = el("input", {
    placeholder: "发件人包含，如 boss@corp.com（留空=任意）",
    value: existing?.match_from || "",
  });
  const matchTo = el("input", {
    placeholder: "收件人包含，如 me@mydomain.com（留空=任意）",
    value: existing?.match_to || "",
  });
  const target = el("input", {
    placeholder: "转发目标邮箱（须为 CF 已验证 Destination）",
    value: existing?.target || "",
  });
  const keep = el("select", {});
  for (const [v, l] of [["1", "转发并存档"], ["0", "转发后不存档"]]) {
    const opt = el("option", { value: v }, l);
    // 新建默认「转发并存档」；编辑沿用原值
    const cur = existing ? String(existing.keep_original) : "1";
    if (cur === v) opt.selected = true;
    keep.appendChild(opt);
  }
  const enabled = el("select", {});
  for (const [v, l] of [["1", "启用"], ["0", "停用"]]) {
    const opt = el("option", { value: v }, l);
    if ((existing ? String(existing.enabled) : "1") === v) opt.selected = true;
    enabled.appendChild(opt);
  }
  const err = el("div", { class: "msg-error" });

  const mask = el("div", { class: "modal-mask" });
  const close = () => mask.remove();
  const saveBtn = el("button", { class: "primary" }, "保存");
  saveBtn.onclick = async () => {
    err.textContent = "";
    try {
      const payload = {
        matchFrom: matchFrom.value.trim(),
        matchTo: matchTo.value.trim(),
        target: target.value.trim(),
        keepOriginal: keep.value === "1",
        enabled: enabled.value === "1",
      };
      const url = existing ? "/api/forward-rules/" + existing.id : "/api/forward-rules";
      await api(url, { method: existing ? "PUT" : "POST", body: JSON.stringify(payload) });
      close();
      renderForwardRules();
    } catch (e) {
      err.textContent = e.message;
    }
  };

  mask.appendChild(
    el(
      "div",
      { class: "modal" },
      el("h3", {}, existing ? "编辑转发规则" : "新增转发规则"),
      el("div", { class: "field" }, el("label", {}, "发件人包含"), matchFrom),
      el("div", { class: "field" }, el("label", {}, "收件人包含"), matchTo),
      el("div", { class: "field" }, el("label", {}, "转发到"), target),
      el("div", { class: "field" }, el("label", {}, "原件处理"), keep),
      el("div", { class: "field" }, el("label", {}, "状态"), enabled),
      err,
      el("div", { class: "modal-actions" }, el("button", { onclick: close }, "取消"), saveBtn),
    ),
  );
  mask.addEventListener("click", (e) => e.target === mask && close());
  document.body.appendChild(mask);
}

async function delForwardRule(id) {
  if (!confirm("确定删除该转发规则？")) return;
  await api("/api/forward-rules/" + id, { method: "DELETE" });
  renderForwardRules();
}

// ── 路由 ──
function renderApp() {
  const hash = location.hash.replace(/^#\//, "") || "inbox";
  state.route = hash;
  const [head, arg] = hash.split("/");

  if (head === "mail" && arg) return renderDetail(arg);
  if (head === "providers") return renderProviders();
  if (head === "rules") {
    state.page = 1;
    return renderRules();
  }
  if (head === "forward-rules") {
    state.page = 1;
    return renderForwardRules();
  }
  const nav = NAV.find((n) => n.key === head);
  const folder = nav?.folder ?? "inbox";
  if (state.folder !== folder) state.page = 1;
  return renderMailList(folder);
}

window.addEventListener("hashchange", renderApp);

// ── 启动：检查会话 ──
(async () => {
  try {
    const s = await api("/api/session");
    state.authed = s.authed;
  } catch {
    state.authed = false;
  }
  if (state.authed) {
    if (!location.hash) location.hash = "#/inbox";
    renderApp();
  } else {
    renderLogin();
  }
})();
