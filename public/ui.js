// 轻量 UI 组件：toast 浮层 + confirm/alert 对话框，替代浏览器原生 alert/confirm。
// 纯原生实现，无依赖。样式见 style.css 的 .toast / .dialog 系列。

// ── toast：右下角浮层，自动消失 ──
export function toast(message, type = "info") {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  const item = document.createElement("div");
  item.className = "toast toast-" + type;
  item.textContent = message;
  host.appendChild(item);
  // 进入动画
  requestAnimationFrame(() => item.classList.add("show"));
  const remove = () => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 200);
  };
  setTimeout(remove, type === "error" ? 4500 : 3000);
  item.addEventListener("click", remove);
}

// ── 通用对话框 ──
function dialog({ title, message, okText, cancelText, danger }) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";

    const box = document.createElement("div");
    box.className = "dialog";

    if (title) {
      const h = document.createElement("h3");
      h.textContent = title;
      box.appendChild(h);
    }
    const p = document.createElement("div");
    p.className = "dialog-msg";
    p.textContent = message;
    box.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const done = (val) => {
      mask.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };

    if (cancelText !== null) {
      const cancel = document.createElement("button");
      cancel.textContent = cancelText || "取消";
      cancel.onclick = () => done(false);
      actions.appendChild(cancel);
    }
    const ok = document.createElement("button");
    ok.className = "primary" + (danger ? " danger" : "");
    ok.textContent = okText || "确定";
    ok.onclick = () => done(true);
    actions.appendChild(ok);

    box.appendChild(actions);
    mask.appendChild(box);
    document.body.appendChild(mask);
    ok.focus();

    // Enter=确定，Esc=取消；不支持点遮罩关闭，避免误触
    const onKey = (e) => {
      if (e.key === "Escape" && cancelText !== null) done(false);
      else if (e.key === "Enter") done(true);
    };
    document.addEventListener("keydown", onKey);
  });
}

export function confirmDialog(message, opts = {}) {
  return dialog({
    title: opts.title || "请确认",
    message,
    okText: opts.okText || "确定",
    cancelText: opts.cancelText || "取消",
    danger: opts.danger,
  });
}

export function alertDialog(message, opts = {}) {
  return dialog({
    title: opts.title || "提示",
    message,
    okText: opts.okText || "知道了",
    cancelText: null,
  }).then(() => undefined);
}

// ── 输入对话框：返回输入字符串，取消返回 null ──
export function promptDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    const box = document.createElement("div");
    box.className = "dialog";

    const h = document.createElement("h3");
    h.textContent = opts.title || "请输入";
    box.appendChild(h);

    const p = document.createElement("div");
    p.className = "dialog-msg";
    p.textContent = message;
    box.appendChild(p);

    const input = document.createElement("input");
    input.type = "text";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    box.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const done = (val) => {
      mask.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.onclick = () => done(null);
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = opts.okText || "确定";
    ok.onclick = () => done(input.value.trim() || null);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);

    mask.appendChild(box);
    document.body.appendChild(mask);
    input.focus();

    const onKey = (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter") done(input.value.trim() || null);
    };
    document.addEventListener("keydown", onKey);
  });
}
