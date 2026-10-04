/**
 * DOM 小工具。刻意保持极简：只有「造节点」这一件事，没有虚拟 DOM、没有模板语法。
 * 所有渲染都是纯函数式的「造节点 → 挂进容器」，够用且零依赖。
 */

/**
 * 造一个元素。
 * @param {string} tag - 标签名。
 * @param {object} [props] - 属性；`class`/`text`/`html` 特殊处理，`on*` 绑事件。
 * @param {Array|Node|string} [children] - 子节点。
 * @returns {HTMLElement} 元素。
 */
export function node(tag, props = {}, children = []) {
  const created = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') created.className = value;
    else if (key === 'text') created.textContent = String(value);
    else if (key === 'html') created.innerHTML = value;
    else if (key === 'dataset') Object.assign(created.dataset, value);
    else if (key.startsWith('on')) created.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') created.value = value;
    else if (value === true) created.setAttribute(key, '');
    else created.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    created.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return created;
}

/** 清空容器。 */
export function clear(target) {
  while (target.firstChild) target.removeChild(target.firstChild);
  return target;
}

/** 取 id 元素。 */
export const byId = (id) => document.getElementById(id);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 造一个 SVG 元素（SVG 必须用 createElementNS，普通 createElement 造不出来）。
 * @param {string} tag - 标签名。
 * @param {object} [props] - 属性；`text` 会变成文本子节点。
 * @param {Array} [children] - 子节点。
 * @returns {SVGElement} 元素。
 */
export function svgNode(tag, props = {}, children = []) {
  const created = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') {
      created.appendChild(document.createTextNode(String(value)));
      continue;
    }
    if (key.startsWith('on')) {
      created.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    created.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    created.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return created;
}

/** 状态徽章。 */
export function badge(text, kind = 'idle') {
  return node('span', { class: `badge badge-${kind}`, text });
}

/** 键值表；value 为空自动跳过。 */
export function kv(pairs) {
  const list = node('dl', { class: 'kv' });
  for (const [key, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    list.appendChild(node('dt', { text: key }));
    list.appendChild(node('dd', { text: String(value) }));
  }
  return list;
}

/** 卡片：标题 + 右上角徽章 + 内容。 */
export function card(title, badgeNode, bodyNodes = []) {
  return node('div', { class: 'card' }, [
    node('div', { class: 'card-head' }, [
      node('span', { class: 'card-title', text: title }),
      badgeNode,
    ]),
    ...[].concat(bodyNodes).filter(Boolean),
  ]);
}

/** 面板：带标题与可选操作区。 */
export function panel(title, actions, bodyNodes = []) {
  return node('section', { class: 'panel' }, [
    node('div', { class: 'panel-head' }, [
      title ? node('h2', { text: title }) : null,
      actions ? node('div', { class: 'panel-actions' }, [].concat(actions)) : null,
    ]),
    ...[].concat(bodyNodes).filter(Boolean),
  ]);
}

/** 命令行 + 复制按钮。 */
export function commandRow(command, hint) {
  return node('div', { class: 'fix' }, [
    node('code', { text: command }),
    copyButton(command),
    hint ? node('span', { class: 'muted', text: hint }) : null,
  ]);
}

/** 复制按钮（用事件委托也能用）。 */
export function copyButton(text) {
  return node('button', {
    type: 'button',
    class: 'btn',
    text: '复制',
    onclick: () => copy(text),
  });
}

/** 复制到剪贴板；失败时退回 textarea + execCommand。 */
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
    return true;
  } catch {
    /* 继续走兜底 */
  }
  const area = node('textarea', { value: text });
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  toast(ok ? '已复制' : '复制失败，请手动选中');
  return ok;
}

let toastTimer = null;

/** 底部轻提示。 */
export function toast(message, kind = 'info') {
  const el = byId('toast');
  if (!el) return;
  el.textContent = String(message);
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 4200 : 2200);
}

/** 空状态块。 */
export function emptyState(title, detail, actions) {
  return node('div', { class: 'empty' }, [
    node('div', { class: 'empty-title', text: title }),
    detail ? node('div', { class: 'empty-detail', text: detail }) : null,
    actions ? node('div', { class: 'empty-actions' }, [].concat(actions)) : null,
  ]);
}

/** 一个按钮。 */
export function button(label, onclick, variant = '') {
  return node('button', {
    type: 'button',
    class: `btn${variant ? ` btn-${variant}` : ''}`,
    text: label,
    onclick,
  });
}

/** 下拉选择。 */
export function select(options, value, onchange, { allLabel = null } = {}) {
  const el = node('select', { onchange: (event) => onchange(event.target.value) });
  if (allLabel !== null) el.appendChild(node('option', { value: '', text: allLabel }));
  for (const option of options) {
    const entry = typeof option === 'string' ? { value: option, label: option } : option;
    el.appendChild(
      node('option', { value: entry.value, text: entry.label ?? entry.value, selected: entry.value === value }),
    );
  }
  el.value = value ?? '';
  return el;
}

/** 文本输入。 */
export function input(value, placeholder, oninput, { type = 'text' } = {}) {
  return node('input', {
    type,
    value: value ?? '',
    placeholder: placeholder ?? '',
    spellcheck: 'false',
    oninput: oninput ? (event) => oninput(event.target.value) : null,
  });
}
