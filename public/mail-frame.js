// 邮件正文安全渲染：sandboxed iframe（不给 allow-scripts）+ srcdoc。
// 外链图片默认剥离，点击"加载图片"后再恢复，防脚本注入与追踪像素。

// 把 HTML 中的 <img src> 暂存到 data-blocked-src，阻断自动加载
function blockRemoteImages(html) {
  let blocked = 0;
  const out = html.replace(
    /<img\b([^>]*?)\ssrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
    (_m, pre, _q, src, post) => {
      if (/^(cid:|data:)/i.test(src)) {
        return `<img${pre} src="${src}"${post}>`; // 内嵌图不算外链
      }
      blocked++;
      return `<img${pre} data-blocked-src="${escapeAttr(src)}"${post}>`;
    },
  );
  return { html: out, blocked };
}

function escapeAttr(s) {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// CSP 通过 meta 注入 iframe：默认拒绝一切远程资源；加载图片时放开 img-src
function wrapDocument(bodyHtml, allowImages) {
  const imgSrc = allowImages ? "https: data: cid:" : "'none'";
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
  ].join("; ");
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <base target="_blank">
    <style>body{font-family:-apple-system,"PingFang SC",sans-serif;color:#1f2733;margin:12px;line-height:1.6;} img{max-width:100%;} a{color:#2563eb;}</style>
  </head><body>${bodyHtml}</body></html>`;
}

// 渲染入口：container 内放一个 iframe + 图片提示条
export function renderMailBody(container, html, text) {
  container.innerHTML = "";

  if (!html) {
    const pre = document.createElement("div");
    pre.className = "body-text";
    pre.textContent = text || "(无正文)";
    container.appendChild(pre);
    return;
  }

  const { html: safe, blocked } = blockRemoteImages(html);
  let imagesShown = false;

  const iframe = document.createElement("iframe");
  iframe.className = "body-frame";
  // 关键：sandbox 不含 allow-scripts → 邮件内脚本无法执行
  iframe.setAttribute("sandbox", "allow-same-origin allow-popups");
  iframe.setAttribute("referrerpolicy", "no-referrer");

  function draw() {
    let doc = safe;
    if (imagesShown) {
      // 恢复被阻断的图片
      doc = doc.replace(/data-blocked-src=/gi, "src=");
    }
    iframe.srcdoc = wrapDocument(doc, imagesShown);
  }

  if (blocked > 0) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.innerHTML = `已阻止 ${blocked} 张外链图片（防追踪像素）。`;
    const btn = document.createElement("button");
    btn.textContent = "加载图片";
    btn.onclick = () => {
      imagesShown = true;
      banner.remove();
      draw();
    };
    banner.appendChild(btn);
    container.appendChild(banner);
  }

  container.appendChild(iframe);
  draw();

  // 内容高度自适应（同源 iframe 可读取）
  iframe.addEventListener("load", () => {
    try {
      const h = iframe.contentDocument.body.scrollHeight;
      if (h) iframe.style.height = h + 40 + "px";
    } catch {
      /* ignore */
    }
  });
}
