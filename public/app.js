import { renderMailBody } from "/mail-frame.js";
import { toast, confirmDialog, alertDialog, promptDialog, showLoading, hideLoading } from "/ui.js";

const app = document.getElementById("app");
const state = {
  authed: false,
  needsSetup: false,
  primaryDomain: "",
  route: "",
  folder: "inbox",
  page: 1,
  q: "",
  contactQ: "",
};

// ── fetch 封装 ──
async function api(path, opts = {}) {
  // silent：跳过全屏 loading（用于收件人联想等高频后台查询，避免界面反复闪烁）
  const { silent = false, ...rest } = opts;
  if (!silent) showLoading();
  try {
    const res = await fetch(path, {
      headers: { "content-type": "application/json", ...(rest.headers || {}) },
      ...rest,
    });
    if (res.status === 401) {
      state.authed = false;
      renderLogin();
      throw new Error("未登录");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    if (!silent) hideLoading();
  }
}

// 文件上传（multipart，不能强制 json content-type）
async function uploadFile(file) {
  showLoading();
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    hideLoading();
  }
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

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// 字节输入框的快捷标签：点击直接把对应字节数填入 input。presets 为 [标签, 字节] 列表。
function presetRow(input, presets) {
  const row = el("div", { class: "preset-row" });
  for (const [label, bytes] of presets) {
    const chip = el("button", { type: "button", class: "preset-chip" }, label);
    chip.onclick = () => {
      input.value = String(bytes);
    };
    row.appendChild(chip);
  }
  return row;
}
const KB = 1024;
const MB = 1024 * 1024;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 解析 "Name <a@b>" 或纯地址 → { name, email }
function parseAddr(raw) {
  const s = (raw || "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m) {
    return {
      name: s.slice(0, m.index).trim().replace(/^["']|["']$/g, ""),
      email: m[1].trim(),
    };
  }
  return { name: "", email: s };
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 首次引导：设置初始密码 ──
function renderSetup() {
  const err = el("div", { class: "msg-error" });
  const pwd = el("input", { type: "password", placeholder: "至少 6 位" });
  const pwd2 = el("input", { type: "password", placeholder: "再次输入" });
  const submit = async () => {
    err.textContent = "";
    if (pwd.value.length < 6) return (err.textContent = "密码至少 6 位");
    if (pwd.value !== pwd2.value) return (err.textContent = "两次输入不一致");
    try {
      await api("/api/setup", {
        method: "POST",
        body: JSON.stringify({ password: pwd.value }),
      });
      state.authed = true;
      state.needsSetup = false;
      toast("已设置管理密码", "ok");
      location.hash = "#/inbox";
      await refreshSession();
      renderApp();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  pwd2.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  app.innerHTML = "";
  app.appendChild(
    el(
      "div",
      { class: "login-wrap" },
      el(
        "div",
        { class: "login-card" },
        el("h1", {}, "初始化 mail-relay"),
        el("div", { class: "hint", style: "margin-bottom:14px" }, "首次使用，请设置后台管理密码。"),
        el("div", { class: "field" }, el("label", {}, "管理密码"), pwd),
        el("div", { class: "field" }, el("label", {}, "确认密码"), pwd2),
        err,
        el("button", { class: "primary", onclick: submit, style: "width:100%" }, "设置并进入"),
      ),
    ),
  );
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
      await refreshSession();
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
  { key: "contacts", label: "通讯录" },
  { key: "providers", label: "发送通道" },
  { key: "rules", label: "收信规则" },
  { key: "forward-rules", label: "转发规则" },
  { key: "settings", label: "设置" },
];

function renderShell(activeKey, contentNode) {
  const sidebar = el("div", { class: "sidebar" }, el("div", { class: "brand" }, "📮 mail-relay"));
  for (const n of NAV) {
    sidebar.appendChild(
      el(
        "button",
        {
          class: "nav-item" + (n.key === activeKey ? " active" : ""),
          onclick: () => {
            location.hash = "#/" + n.key;
            closeDrawer();
          },
        },
        n.label,
      ),
    );
  }
  sidebar.appendChild(el("div", { class: "spacer" }));

  // 当前账号：已设主域显示 admin@主域，未设则提示去设置（保存主域后就地刷新）
  sidebar.appendChild(accountLabel());

  sidebar.appendChild(
    el(
      "button",
      {
        class: "nav-item",
        onclick: async () => {
          closeDrawer();
          if (!(await confirmDialog("确定要退出登录吗？"))) return;
          await api("/api/logout", { method: "POST" });
          state.authed = false;
          renderLogin();
        },
      },
      "退出登录",
    ),
  );

  // 移动端顶部条（含汉堡）与抽屉遮罩；桌面端 CSS 隐藏
  const topbar = el(
    "div",
    { class: "topbar" },
    el("button", { class: "hamburger", onclick: openDrawer }, "☰"),
    el("div", { class: "brand" }, "📮 mail-relay"),
  );
  const mask = el("div", { class: "sidebar-mask", onclick: closeDrawer });

  app.innerHTML = "";
  app.appendChild(
    el(
      "div",
      { class: "layout" },
      topbar,
      sidebar,
      mask,
      el("div", { class: "main" }, contentNode),
    ),
  );
}

function openDrawer() {
  document.querySelector(".sidebar")?.classList.add("open");
  document.querySelector(".sidebar-mask")?.classList.add("open");
}
function closeDrawer() {
  document.querySelector(".sidebar")?.classList.remove("open");
  document.querySelector(".sidebar-mask")?.classList.remove("open");
}

// 侧边栏账号标签：已设主域显示 admin@主域，未设则可点击跳设置页
function accountLabel() {
  return state.primaryDomain
    ? el("div", { class: "account" }, "admin@" + state.primaryDomain)
    : el(
        "div",
        { class: "account account-warn", onclick: () => (location.hash = "#/settings") },
        "请设置主域",
      );
}

// 就地刷新侧边栏账号标签（保存主域后调用，无需整页重渲染）
function refreshAccountLabel() {
  const cur = document.querySelector(".sidebar .account");
  if (cur) cur.replaceWith(accountLabel());
}

// ── 邮件列表 ──
const SEND_STATUS = {
  sent: { label: "已送出", cls: "sent" },
  queued: { label: "重试中", cls: "queued" },
  failed: { label: "发送失败", cls: "failed" },
};

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
    el(
      "button",
      {
        onclick: () => {
          state.page = 1;
          renderMailList(folder);
          toast("已刷新", "info");
        },
      },
      folder === "inbox" ? "🔄 检查新邮件" : "🔄 刷新",
    ),
    el("button", { class: "primary", onclick: () => (location.hash = "#/compose") }, "✏️ 写邮件"),
  );
  content.appendChild(toolbar);

  const listBox = el("div", { class: "mail-list" }, el("div", { class: "empty" }, "加载中…"));
  content.appendChild(listBox);

  try {
    const params = new URLSearchParams({ folder, page: state.page, pageSize: 20 });
    if (state.q) params.set("q", state.q);
    const data = await api("/api/mails?" + params.toString());
    listBox.innerHTML = "";
    if (!data.items.length) {
      listBox.appendChild(el("div", { class: "empty" }, "没有邮件"));
    } else {
      for (const m of data.items) {
        const st = m.send_status ? SEND_STATUS[m.send_status] : null;
        const metaChildren = [];
        if (st) metaChildren.push(el("span", { class: "badge " + st.cls }, st.label));
        if (m.send_status === "failed") {
          const retry = el("button", { class: "mini" }, "重试");
          retry.onclick = (e) => {
            e.stopPropagation();
            retryMail(m.id);
          };
          metaChildren.push(retry);
        }
        metaChildren.push(el("span", {}, fmtDate(m.created_at)));

        listBox.appendChild(
          el(
            "div",
            {
              class: "mail-row" + (m.is_read ? "" : " unread"),
              onclick: () => (location.hash = "#/mail/" + m.id),
            },
            el(
              "div",
              { class: "from", title: m.from_addr },
              el("span", { class: "addr-tag" }, "From"),
              el("span", { class: "addr-val" }, m.from_addr),
            ),
            el(
              "div",
              { class: "to", title: m.to_addr },
              el("span", { class: "addr-tag" }, "To"),
              el("span", { class: "addr-val" }, m.to_addr),
            ),
            el(
              "div",
              { class: "subj" },
              m.has_attachments ? el("span", { class: "clip" }, "📎") : null,
              el("span", {}, m.subject || "(无主题)"),
              el("span", { class: "snippet" }, m.snippet || ""),
            ),
            el("div", { class: "meta" }, ...metaChildren),
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

async function retryMail(id) {
  try {
    const res = await api("/api/mails/" + id + "/retry", { method: "POST" });
    if (res.status === "sent") toast("已重新送出", "ok");
    else if (res.status === "queued") toast("已重新进入重试队列", "info");
    else toast("重试失败：" + (res.error || ""), "error");
  } catch (e) {
    toast(e.message, "error");
  }
  renderMailList(state.folder);
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
  const activeKey = NAV.find((n) => n.folder === state.folder)?.key ?? "inbox";
  renderShell(activeKey, el("div", {}, "加载中…"));
  try {
    const m = await api("/api/mails/" + id);
    const content = el("div", {});
    renderShell(activeKey, content);

    // 操作栏
    const actions = el("div", { class: "toolbar" }, el("button", { onclick: () => history.back() }, "‹ 返回"), el("div", { style: "flex:1" }));

    actions.appendChild(el("button", { onclick: () => (location.hash = "#/compose/" + m.id) }, "↩︎ 回复"));

    if (m.direction === "out" && m.send_status === "failed") {
      actions.appendChild(el("button", { onclick: () => retryMail(m.id) }, "🔁 重试"));
    }
    if (m.is_read) {
      actions.appendChild(
        el("button", { onclick: () => markRead(m.id, false) }, "标为未读"),
      );
    }
    if (m.folder === "inbox") {
      actions.appendChild(el("button", { onclick: () => moveMail(m.id, "spam") }, "标记垃圾"));
    }
    if (m.folder === "spam" || m.folder === "trash") {
      actions.appendChild(el("button", { onclick: () => moveMail(m.id, "inbox") }, "移回收件箱"));
    }
    actions.appendChild(
      el(
        "button",
        { class: "danger", onclick: () => deleteMail(m.id, m.folder) },
        m.folder === "trash" ? "彻底删除" : "删除",
      ),
    );
    content.appendChild(actions);

    const detail = el("div", { class: "detail" });
    detail.appendChild(el("h2", {}, m.subject || "(无主题)"));

    const fromRow = el("div", { class: "hdr-row" }, "发件人：" + m.from_addr);
    if (m.from_saved === false) {
      const saveBtn = el("button", { class: "mini", style: "margin-left:8px" }, "＋ 存入通讯录");
      saveBtn.onclick = async () => {
        const { name, email } = parseAddr(m.from_addr);
        try {
          await api("/api/contacts", {
            method: "POST",
            body: JSON.stringify({ name, email }),
          });
          toast("已存入通讯录", "ok");
          saveBtn.remove();
        } catch (e) {
          toast(e.message, "error");
        }
      };
      fromRow.appendChild(saveBtn);
    }
    detail.appendChild(fromRow);
    detail.appendChild(el("div", { class: "hdr-row" }, "收件人：" + m.to_addr));
    detail.appendChild(el("div", { class: "hdr-row" }, "时间：" + new Date(m.created_at).toLocaleString("zh-CN")));

    if (m.direction === "out" && m.send_status) {
      const st = SEND_STATUS[m.send_status];
      const row = el("div", { class: "hdr-row" }, "发送状态：", el("span", { class: "badge " + st.cls }, st.label));
      if (m.send_status === "failed" && m.send_error) {
        row.appendChild(el("span", { class: "hint", style: "margin-left:8px" }, m.send_error));
      }
      detail.appendChild(row);
    }

    if (m.needs_parse) {
      detail.appendChild(el("div", { class: "banner" }, "此邮件解析失败，请下载原始 .eml 查看。"));
    }

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

    const bodyBox = el("div", {});
    detail.appendChild(bodyBox);
    renderMailBody(bodyBox, m.body_html, m.body_text);

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
    renderShell(activeKey, el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

async function markRead(id, read) {
  try {
    await api("/api/mails/" + id + "/read", {
      method: "POST",
      body: JSON.stringify({ read }),
    });
    toast(read ? "已标为已读" : "已标为未读", "info");
    location.hash = "#/" + state.folder;
  } catch (e) {
    toast(e.message, "error");
  }
}

async function moveMail(id, folder) {
  try {
    await api("/api/mails/" + id + "/move", {
      method: "POST",
      body: JSON.stringify({ folder }),
    });
    toast("已移动", "info");
    location.hash = "#/" + state.folder;
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteMail(id, folder) {
  const permanent = folder === "trash";
  const ok = await confirmDialog(
    permanent ? "彻底删除后不可恢复（含附件与原始邮件），确定？" : "将移入废纸篓，确定？",
    { danger: true, okText: permanent ? "彻底删除" : "删除" },
  );
  if (!ok) return;
  try {
    await api("/api/mails/" + id, { method: "DELETE" });
    toast(permanent ? "已彻底删除" : "已移入废纸篓", "info");
    location.hash = "#/" + state.folder;
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── 撰写 / 回复（独立页面）──
async function renderCompose(replyMailId) {
  renderShell("", el("div", {}, "加载中…"));
  let reply = null;
  if (replyMailId) {
    try {
      reply = await api("/api/mails/" + replyMailId);
    } catch (e) {
      toast("无法加载原邮件：" + e.message, "error");
    }
  }

  const content = el("div", {});
  renderShell("", content);

  const defaultFrom = reply
    ? reply.to_addr.split(",")[0].trim()
    : state.primaryDomain
      ? "admin@" + state.primaryDomain
      : "";

  const from = el("input", { placeholder: "发件人，如 me@yourdomain.com", value: defaultFrom });
  const to = el("input", {
    placeholder: "收件人，多个用逗号分隔",
    value: reply ? reply.from_addr : "",
    autocomplete: "off",
  });
  // 收件人通讯录联想下拉
  const acDropdown = el("div", { class: "contact-dropdown" });
  const toWrap = el("div", { class: "autocomplete" }, to, acDropdown);
  let acTimer = null;
  const acFragment = () => {
    const start = to.value.lastIndexOf(",") + 1;
    return { start, text: to.value.slice(start).trim() };
  };
  const acClose = () => {
    acDropdown.innerHTML = "";
    acDropdown.classList.remove("open");
  };
  const acRun = async () => {
    const { text } = acFragment();
    if (!text) return acClose();
    let data;
    try {
      data = await api("/api/contacts?pageSize=8&q=" + encodeURIComponent(text), {
        silent: true,
      });
    } catch {
      return acClose();
    }
    if (!data.items.length) return acClose();
    acDropdown.innerHTML = "";
    for (const c of data.items) {
      const label = c.name ? `${c.name} <${c.email}>` : c.email;
      const item = el(
        "div",
        { class: "ac-item" },
        c.name ? el("span", { class: "ac-name" }, c.name) : null,
        el("span", { class: "ac-email" }, c.email),
      );
      item.onmousedown = (e) => {
        e.preventDefault();
        const { start } = acFragment();
        const before = to.value.slice(0, start);
        to.value = (before ? before + " " : "") + label + ", ";
        acClose();
        to.focus();
      };
      acDropdown.appendChild(item);
    }
    acDropdown.classList.add("open");
  };
  to.addEventListener("input", () => {
    clearTimeout(acTimer);
    acTimer = setTimeout(acRun, 150);
  });
  to.addEventListener("blur", () => setTimeout(acClose, 150));
  to.addEventListener("keydown", (e) => e.key === "Escape" && acClose());

  const subject = el("input", {
    placeholder: "主题",
    value: reply ? (reply.subject?.startsWith("Re:") ? reply.subject : "Re: " + (reply.subject || "")) : "",
  });

  // 富文本编辑区
  const editor = el("div", { class: "rte-body", contenteditable: "true" });
  if (reply) {
    const quoted = reply.body_text || stripHtml(reply.body_html || "");
    editor.innerHTML =
      "<p><br></p><div class='quote-hdr'>——— 原始邮件 ———</div><blockquote>" +
      escapeHtml(quoted).replace(/\n/g, "<br>") +
      "</blockquote>";
  }

  const exec = (cmd, arg) => {
    document.execCommand(cmd, false, arg);
    editor.focus();
  };
  const rteBtn = (label, cmd) => {
    const b = el("button", { type: "button", class: "rte-btn" }, label);
    b.onmousedown = (e) => e.preventDefault(); // 保持选区
    b.onclick = () => exec(cmd);
    return b;
  };
  const linkBtn = el("button", { type: "button", class: "rte-btn" }, "🔗");
  linkBtn.onmousedown = (e) => e.preventDefault();
  linkBtn.onclick = async () => {
    const url = await promptDialog("输入链接地址", { placeholder: "https://…" });
    if (url) exec("createLink", url);
  };
  const toolbar = el(
    "div",
    { class: "rte-toolbar" },
    rteBtn("B", "bold"),
    rteBtn("I", "italic"),
    rteBtn("U", "underline"),
    rteBtn("• 列表", "insertUnorderedList"),
    rteBtn("1. 列表", "insertOrderedList"),
    linkBtn,
    rteBtn("清除格式", "removeFormat"),
  );

  // 附件区
  const pending = [];
  const chips = el("div", { class: "att-list" });
  const fileInput = el("input", { type: "file", multiple: "", style: "display:none" });
  const drawChips = () => {
    chips.innerHTML = "";
    pending.forEach((pa, i) => {
      const rm = el("span", { class: "chip-x" }, "✕");
      rm.onclick = () => {
        pending.splice(i, 1);
        drawChips();
      };
      chips.appendChild(
        el("span", { class: "att-chip" }, `📎 ${pa.filename} (${fmtSize(pa.size)})`, rm),
      );
    });
  };
  fileInput.onchange = async () => {
    for (const file of fileInput.files) {
      try {
        const meta = await uploadFile(file);
        pending.push(meta);
        drawChips();
      } catch (e) {
        toast(`上传 ${file.name} 失败：${e.message}`, "error");
      }
    }
    fileInput.value = "";
  };
  const attachBtn = el("button", { onclick: () => fileInput.click() }, "📎 添加附件");

  const err = el("div", { class: "msg-error" });
  const sendBtn = el("button", { class: "primary" }, reply ? "发送回复" : "发送");
  sendBtn.onclick = async () => {
    err.textContent = "";
    const toList = to.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!toList.length) return (err.textContent = "请填写收件人");
    if (!from.value.trim()) return (err.textContent = "请填写发件人");
    sendBtn.disabled = true;
    try {
      const payload = {
        to: toList,
        from: from.value.trim(),
        subject: subject.value,
        html: editor.innerHTML,
        text: editor.innerText,
        pendingAttachments: pending,
      };
      if (reply) payload.replyToMailId = reply.id;
      const res = await api("/api/send", { method: "POST", body: JSON.stringify(payload) });
      if (res.status === "sent") toast("已发送", "ok");
      else if (res.status === "queued") toast("已进入重试队列：" + (res.error || ""), "info");
      else toast("发送失败：" + (res.error || ""), "error");
      location.hash = "#/sent";
    } catch (e) {
      err.textContent = e.message;
      sendBtn.disabled = false;
    }
  };

  content.appendChild(
    el(
      "div",
      { class: "toolbar" },
      el("button", { onclick: () => history.back() }, "‹ 返回"),
      el("h2", {}, reply ? "回复邮件" : "写邮件"),
    ),
  );
  content.appendChild(
    el(
      "div",
      { class: "detail compose" },
      el("div", { class: "field" }, el("label", {}, "发件人"), from),
      el("div", { class: "field" }, el("label", {}, "收件人"), toWrap),
      el("div", { class: "field" }, el("label", {}, "主题"), subject),
      el("div", { class: "field" }, el("label", {}, "正文"), el("div", { class: "rte" }, toolbar, editor)),
      el("div", { class: "field" }, attachBtn, fileInput, chips),
      err,
      el("div", { class: "modal-actions" }, el("button", { onclick: () => history.back() }, "取消"), sendBtn),
    ),
  );
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
        el("td", {}, p.is_active ? el("span", { class: "badge active" }, "激活中") : "—"),
        el("td", {}, p.last_verified_at ? new Date(p.last_verified_at).toLocaleString("zh-CN") : "未验证"),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            el("button", { onclick: () => verifyProvider(p.id) }, "测试"),
            p.is_active ? null : el("button", { onclick: () => activateProvider(p.id) }, "激活"),
            el("button", { onclick: () => openProviderForm(p) }, "编辑"),
            el("button", { class: "danger", onclick: () => delProvider(p.id) }, "删除"),
          ),
        ),
      ),
    );
    box.appendChild(
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, el("th", {}, "名称"), el("th", {}, "类型"), el("th", {}, "状态"), el("th", {}, "最近验证"), el("th", {}, "操作"))),
          el("tbody", {}, ...rows),
        ),
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
    if (data.ok) toast("连接正常 ✓", "ok");
    else toast("验证失败：" + (data.error || ""), "error");
    renderProviders();
  } catch (e) {
    toast("验证出错：" + e.message, "error");
  }
}
async function activateProvider(id) {
  await api("/api/providers/" + id + "/activate", { method: "POST" });
  toast("已激活", "ok");
  renderProviders();
}
async function delProvider(id) {
  if (!(await confirmDialog("确定删除该通道？", { danger: true }))) return;
  try {
    await api("/api/providers/" + id, { method: "DELETE" });
    toast("已删除", "info");
    renderProviders();
  } catch (e) {
    toast(e.message, "error");
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
      const field = el("div", { class: "field" }, el("label", {}, f.label + (f.required ? " *" : "")), input);
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
      toast("已保存", "ok");
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
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, el("th", {}, "匹配字段"), el("th", {}, "包含"), el("th", {}, "动作"), el("th", {}, "状态"), el("th", {}, "操作"))),
          el("tbody", {}, ...rows),
        ),
      ),
    );
    content.appendChild(renderPager(data, renderRules));
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

const kindLabel = (k) => ({ from: "发件人", to: "收件人", subject: "主题" })[k] || "任意";
const actionLabel = (a) => ({ reject: "拒收", spam: "标记垃圾", trash: "移入废纸篓" })[a] || a;

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
      toast("已保存", "ok");
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
  document.body.appendChild(mask);
}

async function delRule(id) {
  if (!(await confirmDialog("确定删除该规则？", { danger: true }))) return;
  await api("/api/rules/" + id, { method: "DELETE" });
  toast("已删除", "info");
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
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, el("th", {}, "发件人含"), el("th", {}, "收件人含"), el("th", {}, "转发到"), el("th", {}, "原件"), el("th", {}, "状态"), el("th", {}, "操作"))),
          el("tbody", {}, ...rows),
        ),
      ),
    );
    content.appendChild(renderPager(data, renderForwardRules));
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

function openForwardRuleForm(existing) {
  const matchFrom = el("input", { placeholder: "发件人包含，如 boss@corp.com（留空=任意）", value: existing?.match_from || "" });
  const matchTo = el("input", { placeholder: "收件人包含，如 me@mydomain.com（留空=任意）", value: existing?.match_to || "" });
  const target = el("input", { placeholder: "转发目标邮箱（须为 CF 已验证 Destination）", value: existing?.target || "" });
  const keep = el("select", {});
  for (const [v, l] of [["1", "转发并存档"], ["0", "转发后不存档"]]) {
    const opt = el("option", { value: v }, l);
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
      toast("已保存", "ok");
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
  document.body.appendChild(mask);
}

async function delForwardRule(id) {
  if (!(await confirmDialog("确定删除该转发规则？", { danger: true }))) return;
  await api("/api/forward-rules/" + id, { method: "DELETE" });
  toast("已删除", "info");
  renderForwardRules();
}

// ── 通讯录 ──
async function renderContacts() {
  const content = el("div", {});
  renderShell("contacts", content);

  const search = el("input", {
    class: "search",
    placeholder: "搜索姓名/邮箱…",
    value: state.contactQ,
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.contactQ = search.value;
      state.page = 1;
      renderContacts();
    }
  });
  content.appendChild(
    el(
      "div",
      { class: "toolbar" },
      el("h2", {}, "通讯录"),
      search,
      el("button", { class: "primary", onclick: () => openContactForm() }, "＋ 新增联系人"),
    ),
  );

  const box = el("div", {}, "加载中…");
  content.appendChild(box);
  try {
    const params = new URLSearchParams({ page: state.page, pageSize: 20 });
    if (state.contactQ) params.set("q", state.contactQ);
    const data = await api("/api/contacts?" + params.toString());
    box.innerHTML = "";
    if (!data.items.length) {
      box.appendChild(
        el("div", { class: "empty" }, "通讯录为空。发送成功的收件人会自动加入，也可手动新增。"),
      );
      return;
    }
    const rows = data.items.map((c) =>
      el(
        "tr",
        {},
        el("td", {}, c.name || "—"),
        el("td", {}, c.email),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            el("button", { onclick: () => openContactForm(c) }, "编辑"),
            el("button", { class: "danger", onclick: () => delContact(c.id) }, "删除"),
          ),
        ),
      ),
    );
    box.appendChild(
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, el("th", {}, "姓名"), el("th", {}, "邮箱"), el("th", {}, "操作"))),
          el("tbody", {}, ...rows),
        ),
      ),
    );
    content.appendChild(renderPager(data, renderContacts));
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
  }
}

function openContactForm(existing) {
  const name = el("input", { placeholder: "姓名（可选）", value: existing?.name || "" });
  const email = el("input", { placeholder: "邮箱，如 a@b.com", value: existing?.email || "" });
  const err = el("div", { class: "msg-error" });
  const mask = el("div", { class: "modal-mask" });
  const close = () => mask.remove();
  const saveBtn = el("button", { class: "primary" }, "保存");
  saveBtn.onclick = async () => {
    err.textContent = "";
    if (!email.value.trim()) return (err.textContent = "请填写邮箱");
    try {
      const url = existing ? "/api/contacts/" + existing.id : "/api/contacts";
      await api(url, {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify({ name: name.value.trim(), email: email.value.trim() }),
      });
      close();
      toast("已保存", "ok");
      renderContacts();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  mask.appendChild(
    el(
      "div",
      { class: "modal" },
      el("h3", {}, existing ? "编辑联系人" : "新增联系人"),
      el("div", { class: "field" }, el("label", {}, "姓名"), name),
      el("div", { class: "field" }, el("label", {}, "邮箱"), email),
      err,
      el("div", { class: "modal-actions" }, el("button", { onclick: close }, "取消"), saveBtn),
    ),
  );
  document.body.appendChild(mask);
}

async function delContact(id) {
  if (!(await confirmDialog("确定删除该联系人？", { danger: true }))) return;
  await api("/api/contacts/" + id, { method: "DELETE" });
  toast("已删除", "info");
  renderContacts();
}

// ── 设置 ──
async function renderSettings() {
  const content = el("div", {});
  renderShell("settings", content);
  content.appendChild(el("div", { class: "toolbar" }, el("h2", {}, "设置")));
  const box = el("div", {}, "加载中…");
  content.appendChild(box);

  let s;
  try {
    s = await api("/api/settings");
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "empty" }, "加载失败：" + e.message));
    return;
  }
  box.innerHTML = "";

  // 常规设置
  const primaryDomain = el("input", { placeholder: "如 yourdomain.com", value: s.primaryDomain || "" });
  const dailySendLimit = el("input", { type: "number", value: s.dailySendLimit });
  const maxMailSize = el("input", { type: "number", min: "1", max: "26214400", value: s.maxMailSize });
  const bodyInlineMax = el("input", { type: "number", min: "1", max: "1048576", value: s.bodyInlineMax });
  const loginMaxFails = el("input", { type: "number", value: s.loginMaxFails });
  const loginLockSeconds = el("input", { type: "number", value: s.loginLockSeconds });
  const gErr = el("div", { class: "msg-error" });
  const saveGeneral = el("button", { class: "primary" }, "保存设置");
  saveGeneral.onclick = async () => {
    gErr.textContent = "";
    const domain = primaryDomain.value.trim().toLowerCase();
    if (domain && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      return (gErr.textContent = "主域名格式不正确，例如 yourdomain.com");
    }
    saveGeneral.disabled = true;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          primaryDomain: domain,
          dailySendLimit: Number(dailySendLimit.value),
          maxMailSize: Number(maxMailSize.value),
          bodyInlineMax: Number(bodyInlineMax.value),
          loginMaxFails: Number(loginMaxFails.value),
          loginLockSeconds: Number(loginLockSeconds.value),
        }),
      });
      state.primaryDomain = domain;
      refreshAccountLabel();
      toast("设置已保存", "ok");
    } catch (e) {
      gErr.textContent = e.message;
    }
    saveGeneral.disabled = false;
  };

  box.appendChild(
    el(
      "div",
      { class: "detail", style: "margin-bottom:20px" },
      el("h3", {}, "常规"),
      el("div", { class: "field" }, el("label", {}, "主域名（写邮件默认发件人 admin@主域）"), primaryDomain),
      el("div", { class: "field" }, el("label", {}, "每日发送配额上限"), dailySendLimit),
      el(
        "div",
        { class: "field" },
        el("label", {}, "最大收信大小（字节）"),
        maxMailSize,
        presetRow(maxMailSize, [
          ["5MB", 5 * MB],
          ["10MB", 10 * MB],
          ["15MB", 15 * MB],
          ["20MB", 20 * MB],
          ["25MB", 25 * MB],
        ]),
        el(
          "div",
          { class: "hint" },
          "整封邮件大小上限，超过则在收信时直接拒收、不落库。含 base64 编码后的附件（约膨胀 33%），即原始附件约为此值的 75%。最大 26214400（25MB，CF 邮件路由硬上限），默认 10485760（10MB）。",
        ),
      ),
      el(
        "div",
        { class: "field" },
        el("label", {}, "正文外置 R2 阈值（字节）"),
        bodyInlineMax,
        presetRow(bodyInlineMax, [
          ["128KB", 128 * KB],
          ["256KB", 256 * KB],
          ["512KB", 512 * KB],
          ["768KB", 768 * KB],
          ["1MB", 1 * MB],
        ]),
        el(
          "div",
          { class: "hint" },
          "HTML 正文超过此大小则外置到 R2 存储。最大 1048576（1MB，受 Durable Object SQLite 单行上限约束），默认 262144（256KB）。",
        ),
      ),
      el("div", { class: "field" }, el("label", {}, "登录失败锁定阈值（次）"), loginMaxFails),
      el("div", { class: "field" }, el("label", {}, "登录锁定时长（秒）"), loginLockSeconds),
      gErr,
      el("div", { class: "modal-actions" }, saveGeneral),
    ),
  );

  // 修改密码
  const oldPwd = el("input", { type: "password", placeholder: "当前密码" });
  const newPwd = el("input", { type: "password", placeholder: "新密码，至少 6 位" });
  const newPwd2 = el("input", { type: "password", placeholder: "再次输入新密码" });
  const pErr = el("div", { class: "msg-error" });
  const savePwd = el("button", { class: "primary" }, "修改密码");
  savePwd.onclick = async () => {
    pErr.textContent = "";
    if (newPwd.value.length < 6) return (pErr.textContent = "新密码至少 6 位");
    if (newPwd.value !== newPwd2.value) return (pErr.textContent = "两次新密码不一致");
    savePwd.disabled = true;
    try {
      await api("/api/settings/password", {
        method: "POST",
        body: JSON.stringify({ oldPassword: oldPwd.value, newPassword: newPwd.value }),
      });
      oldPwd.value = newPwd.value = newPwd2.value = "";
      toast("密码已修改", "ok");
    } catch (e) {
      pErr.textContent = e.message;
    }
    savePwd.disabled = false;
  };

  box.appendChild(
    el(
      "div",
      { class: "detail" },
      el("h3", {}, "修改管理密码"),
      el("div", { class: "field" }, el("label", {}, "当前密码"), oldPwd),
      el("div", { class: "field" }, el("label", {}, "新密码"), newPwd),
      el("div", { class: "field" }, el("label", {}, "确认新密码"), newPwd2),
      pErr,
      el("div", { class: "modal-actions" }, savePwd),
    ),
  );
}

// ── 路由 ──
function renderApp() {
  const hash = location.hash.replace(/^#\//, "") || "inbox";
  state.route = hash;
  const [head, arg] = hash.split("/");

  if (head === "compose") return renderCompose(arg);
  if (head === "mail" && arg) return renderDetail(arg);
  if (head === "providers") return renderProviders();
  if (head === "settings") return renderSettings();
  if (head === "contacts") {
    state.page = 1;
    return renderContacts();
  }
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

async function refreshSession() {
  try {
    const s = await api("/api/session");
    state.authed = s.authed;
    state.needsSetup = s.needsSetup;
    state.primaryDomain = s.primaryDomain || "";
  } catch {
    state.authed = false;
  }
}

// ── 启动 ──
(async () => {
  await refreshSession();
  if (state.needsSetup && !state.authed) {
    renderSetup();
  } else if (state.authed) {
    if (!location.hash) location.hash = "#/inbox";
    renderApp();
  } else {
    renderLogin();
  }
})();
